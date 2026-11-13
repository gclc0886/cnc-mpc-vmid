# CNC Kinematic Simulator / Trainer

## Quick Start

1. **Launch the app** before using MCP tools:
   - Electron: `npm start` or `CNC-Trainer.bat`
   - Browser: `npm run dev` (http://localhost:5173)
2. The MCP server starts automatically with Claude Code (configured in `~/.claude.json`)
3. Wait for the green dot in the toolbar — it means WebSocket bridge is connected

## Architecture

```
Claude Code  <-->  MCP Server (stdio, Node.js)
                       |
                  WebSocket :3100
                       |
                  Electron/Browser (React)
                       |
                  Zustand Store <-> KinematicChain Engine
```

- **MCP Server**: `mcp-server/cnc-trainer-mcp.ts` — 27 tools, WebSocket relay; method/param/result contract in `src/api/bridge-types.ts` (shared, type-checked on both sides)
- **Bridge Client**: `src/api/BridgeClient.ts` — browser-side WS client, dispatches commands to Zustand store
- **Store**: `src/store/useMachineStore.ts` — central state (config, chain, toolPath, playback, activeCombination)
- **Engine**: `src/engine/KinematicChain.ts` — forward kinematics, matrix math, types for Combinations/Channels/AccessPatterns
- **G-code**: `src/engine/GCodeParser.ts` is a facade (`parseProgram`) over `src/engine/gcode/`:
  `Lexer` (words, calls, strings, `detectDialect` Sinumerik/Fanuc) → `Interpreter` (modal groups G0-3, G17-19,
  G90/91, G93/94/95, G54…, G70/71/700/710, DIAMON, AC/IC/DC/ACP/ACN, R-params, G4, M2/M30; arcs IJK/CR=/R/TURN=;
  `Diagnostic`s for everything not simulated, naming the phase that adds it) → `Interpolator` (1 mm / 1° steps,
  time per sample from F, G0 per-axis `Rapid` from VMID, G93/G95). TRAORI and cycles: not yet (phases 1c–1d)
- **Program → machine** (`src/engine/gcode/MachineMapper.ts`, no kinematic transformation): axis = R·p + t (TRANS/ATRANS/ROT/AROT, RPY) + work offset (G54…) + tool length along the plane's tool axis (G17→Z). Each `ProgramMove.xf` carries it; samples hold program `x..c` and machine `mx..mc`; `mapPointToAxes` uses the machine values. G53/G153/SUPA targets are converted back to WCS (Sinumerik keeps tool length, Fanuc does not). Tool active on M6 (or on T if the program has no M6); Fanuc length only under G43 H
- **Setup** (`SetupPanel.tsx`, store `workOffsets`/`tools`): G54 defaults to `computeAutoWorkOffset` (program zero on the table leaf, via a 3×3 Jacobian); simulated control starts in G54; tool table persists in localStorage. The spindle leaf is the gauge point; `chain.setTool()` puts the tool tip L below it (`getToolTipMatrix`)
- **VMID**: `src/engine/VMIDLoader.ts` — import/export SolidCAM VMID format (Ver 24-58), parses sub-machines, channels, access patterns
- **3D**: `src/visualization/MachineModel.tsx` — recursive node tree, spindle+tool, protractor discs. Node matrices are copied only when `chain.revision` changes (no per-frame allocations)
- **Path kinematics**: `src/engine/PathKinematics.ts` — FK over every sample on a private chain → `store.pathKin` (TCP on the part `tcpWork`, in machine `tcpWorld`, limit flags + per-axis summary). Re-run by `analyzePath()` in the store on parse / machine edit / sub-machine change; limit violations become diagnostics
- **Tool trace**: `src/visualization/ToolPath.tsx` draws `pathKin` in the table leaf frame ("on part", moves with the table) or machine frame; whole program faint, executed part bright, out-of-limit red; progress updated in `useFrame`
- **Playback**: real time × speed (1/5/20/100/500×), `stepAtTime` binary search; panels re-render ≤10 Hz via `useLiveVersion`; editor is CodeMirror 6 (`GCodeEditor.tsx`) with exec-line decoration, diagnostics in the gutter, double-click = jump to line
- **Presets**: table-chain axis vectors follow ISO 841 (X+ moves the table −X, table A = (−1,0,0)), see the note in `machinePresets.ts`

## Data Model

### KinematicConfig (full machine description)

```typescript
interface KinematicConfig {
  name: string
  type: string                    // 'milling' | 'turn_mill'
  kinematic: string               // 'No-Rotary' | 'Table-Table' | 'Head-Head' | 'Turn-Mill'
  axisCount: number
  linearAxes: string[]            // ['X', 'Y', 'Z']
  rotaryAxes: string[]            // ['A', 'C']
  devices: DeviceDef[]            // spindle + table device trees
  combinations: CombinationDef[]  // sub-machine axis mappings
  channels: ChannelDef[]          // independent axis groups
  accessPatterns: AccessPatternDef[] // axis exchange modes (G140/G142)
  postprocessor: string
}
```

### Combinations (Sub-machines)

A **Combination** defines a pairing of turret (tool) + table (workpiece) with an **axis order** that maps G-code coordinates to physical axes:

```typescript
interface CombinationDef {
  id: number
  name: string          // e.g. 'Spindle_Table', 'Turret1_SubSpindle'
  turretId: number      // device ID of tool chain
  tableId: number       // device ID of workpiece chain
  axesOrder: {
    linear: number[]    // [axisId_for_X, axisId_for_Y, axisId_for_Z]
    rotary: number[]    // [axisId_for_A, axisId_for_B, axisId_for_C]
  }
}
```

**Axis mapping during G-code simulation:**
- `axesOrder.linear[0]` → G-code X, `linear[1]` → Y, `linear[2]` → Z
- `axesOrder.rotary[0]` → G-code A, `rotary[1]` → B, `rotary[2]` → C
- Axis IDs are resolved to axis names via `buildAxisIdMap()` in the store

### Channels

A **Channel** is an independent axis group with its own sub-machines:

```typescript
interface ChannelDef {
  id: number
  name: string
  submachineIds: number[]   // references to Combination IDs
  numLinearAxes: number
  numRotaryAxes: number
}
```

### Access Patterns (Axis Exchange)

Defines which axes can be shared/exchanged between channels (Swiss-type G140/G142):

```typescript
interface AccessPatternDef {
  id: number
  name: string
  axisPermissions: Record<number, string>  // axisId → 'normal'|'forbidden'|'exchange'
}
```

## Sub-machine Selection (Axis Mapping)

The store tracks `activeCombinationId` — which combination (sub-machine) is currently active for G-code simulation.

**How it works:**
1. When a machine loads (`loadConfig`), the first combination is auto-selected
2. `applyStep(step)` reads the active combination's `axesOrder` to map G-code X/Y/Z/A/B/C → physical axis names
3. If no combination exists or is selected, fallback to direct name mapping (X→X, Y→Y, etc.)
4. UI shows a dropdown in PlaybackControls when there are 2+ combinations

**For Mill-Turn machines with multiple sub-machines:**
- Each sub-machine has different axis order (e.g., Turret1_MainSpindle vs Turret1_SubSpindle)
- G-code X may map to different physical axes depending on which sub-machine is active
- User selects the sub-machine before running simulation

## VMID Import/Export

The VMID loader (`VMIDLoader.ts`) handles SolidCAM Virtual Machine ID format:

**Parsed elements:**
- `<SubDevice>` → devices with coordinate systems (`coordSys: {vecX, vecY, vecZ, place}`)
- `<Axis>` → axis tree with vector, center, offset, limits
- `<Combination>` → sub-machine definitions with axis order
- `<Channel>` → channel definitions with sub-machine assignments
- `<AccessPattern>` → axis exchange permissions

**Round-trip support:** Load VMID → modify in UI → export VMID preserves all data including channels, access patterns, and device coordinate systems.

## MCP Tools Reference

### Reading state (non-destructive, call freely)
| Tool | Returns |
|------|---------|
| `get_machine_state` | Name, category, all positions, TCP (MCS/WCS), limit violations, active combination, playback status |
| `get_axis_positions` | `{ "X": 50.0, "Y": 30.0, "Z": -10.0, "A": 45.0 }` |
| `get_tool_position` | TCP in MCS (world) and WCS (table leaf frame = Inv(Table)×Tool, no G54 yet) |
| `get_matrices` | All 4x4 transformation matrices (world + relative) |
| `get_config` | Full KinematicConfig JSON (includes combinations, channels, accessPatterns) |
| `get_animation_state` | currentStep, totalSteps, isPlaying |
| `get_step_info` | `step?` — source line, programmed X..C, machine X..C (after frame/offset/tool), tool, mapped physical axes, limit violations; TCP only for the current step. Does not move the machine |
| `get_setup` | Work offsets G54…G57, auto G54 for this machine, tool table, tools/offsets the program uses |
| `set_work_offset` | `name`, `offset` (partial) — re-simulates at the current step |
| `set_tool` | `key`, `length?`, `radius?`, `remove?` — re-simulates at the current step |
| `capture_screenshot` | `width?` — JPEG of the app window (Electron only) |

### Machine control
| Tool | Params | Effect |
|------|--------|--------|
| `load_preset` | `key`: 3x, 4x, 5x_ac, 5x_bc, turn_mill | Loads built-in preset |
| `load_vmid` | `xml`: VMID XML string | Loads machine from VMID |
| `load_vmid_file` | `path` | Reads a .vmid from disk (ISO-8859-1/UTF-8) and loads it |
| `set_axis_value` | `name`, `value` | Jog single axis (clamped to limits; unknown name → error) |
| `set_axes` | `axes`: {name: value, ...} | Jog several axes, one matrix update |
| `reset_axes` | — | Zero all axes |

### G-code & animation
| Tool | Params | Effect |
|------|--------|--------|
| `load_gcode` | `gcode`: string | Load G-code into editor |
| `load_gcode_file` | `path`, `parse?` | Read a program from disk (UTF-8/Windows-1251), parse by default |
| `parse_gcode` | — | Parse & generate toolpath → `{totalSteps, blocks, duration, dialect, errors, warnings, diagnostics[]}` |
| `play_animation` | — | Start playback |
| `pause_animation` | — | Pause playback |
| `set_animation_step` | `step`: int | Pause, move the machine to the step, return the same info as `get_step_info` + TCP |

**Limits:** jogging clamps; G-code simulation never clamps — out-of-limit values are applied and reported (`limitViolations`, red LIMIT badge in the viewport).

### Configuration editing
| Tool | Params | Effect |
|------|--------|--------|
| `update_axis_config` | `axisName`, `changes` | Modify axis properties |
| `add_axis` | `parentAxisName`, `deviceId`, `axis` | Add axis to device |
| `add_device` | `device`: {name, type, axes} | Add new device (spindle/table) |
| `remove_axis` | `axisName` | Remove axis |

## Common Workflows

### Inspect a machine
```
get_machine_state        # overview
get_axis_positions       # current values
get_matrices             # transformation matrices
get_tool_position        # TCP in MCS/WCS
```

### Load and test a VMID file
```
load_vmid_file(path="C:\\POSTs\\DMC635_SIN\\DMC635_SIN-4X.vmid")
get_machine_state()
set_axis_value(name="A", value=45)
get_tool_position()
```

### Check a postprocessor output
```
load_vmid_file(path=...)
load_gcode_file(path=".../program.mpf")   # parses → totalSteps
get_step_info(step=N)                      # inspect any step without moving
set_animation_step(step=N)                 # move there, get TCP
capture_screenshot()                       # look at it
```

### Build a machine from scratch
```
load_preset(key="3x")                          # start from base
add_axis(parentAxisName="Z", deviceId=1, axis={name:"B", type:"rotary", vector:{x:0,y:1,z:0}, limits:{min:-120,max:120}})
update_axis_config(axisName="B", changes={center:{x:0,y:0,z:200}})
add_device(device={name:"Spindle X", type:"spindle", axes:[{name:"W", type:"linear", vector:{x:1,y:0,z:0}, limits:{min:-500,max:500}}]})
```

## Key Conventions

- **Device types**: `spindle` = tool chain, `table` = workpiece chain
- **Axis types**: `linear` (mm), `rotary` (degrees), `static` (fixed offset)
- **Vector format**: `{x, y, z}` — direction of motion or rotation axis
- **Axis hierarchy**: nested parent→child, each device has its own root axes
- **deviceId**: numeric ID from config (typically 1=Spindle, 2=Table, but check `get_config`)
- **blockIndex in SimPoint**: maps to `parsedBlocks[blockIndex].line` for source G-code line number
- **Combination axesOrder**: axis IDs (not names!) — resolved once into `axisMapping` (`src/engine/AxisMapping.ts`) on load / sub-machine change
- **Channels**: independent groups — each channel has its own sub-machines and axis budget
- **Access patterns**: axis exchange modes — `normal` (own channel), `forbidden` (disabled), `exchange` (borrowed from other channel)

## Troubleshooting

- **"CNC Trainer not connected"**: App not running or WS not connected. Start app first.
- **Port 3100 in use**: a newer MCP server asks the current owner to release the port ("takeover", latest session wins) and servers exit when Claude Code closes stdio. A server from before this change won't respond — the tool error says so; then `netstat -ano | findstr :3100` → `taskkill /PID <pid> /F` (the new server reconnects by itself every 5 s).
- **Second app instance / testing**: `CNC_BRIDGE_PORT=3101 npm start` + MCP server with the same env var.

## Tests

- `npm test` — unit tests (Vitest), `npm run typecheck` — app types, `npx tsc -p mcp-server/tsconfig.json` — MCP server types.
- `CNC_VMID_CORPUS=C:\POSTs npm test` — also parses every real VMID in that folder and prints a summary of known loader gaps. VMIDs stay out of the repo.
- `CNC_GCODE_CORPUS="C:\CLAUDE-MCP\sinumeric-4x;C:\CLAUDE-MCP\Experiment\G-codes"` — interprets real programs (`;`-separated dirs or files); fails on any interpreter error, prints a warning summary. Programs stay out of the repo.
- Roadmap and known defects: `docs/UPGRADE_PLAN.md`.
- **App crashes on add_axis**: Check that `vector` uses `{x,y,z}` format, not array `[x,y,z]`
- **Machine disappears after config edit**: Fixed — `loadConfig(config, true)` preserves state
- **Protractor labels too small**: Font size in `createProtractorTexture()` in MachineModel.tsx
- **G-code axes map wrong on Mill-Turn**: Check that the correct sub-machine (combination) is selected in the PlaybackControls dropdown
- **VMID loses channels/access patterns**: Ensure `parseChannels()` and `parseAccessPatterns()` are called during import, and `exportVMID()` writes them back

## File Locations

| What | Path |
|------|------|
| MCP config (global) | `~/.claude.json` → `mcpServers.cnc-trainer` |
| MCP config (project) | `.mcp.json` |
| Machine presets | `src/presets/machinePresets.ts` |
| Sample VMID | `DMC635_SIN-4X.vmid` |
| Electron entry | `electron/main.js` |
| CSS styles | `src/index.css` |
| Store (state) | `src/store/useMachineStore.ts` |
| Kinematic types | `src/engine/KinematicChain.ts` |
| VMID loader | `src/engine/VMIDLoader.ts` |
| G-code parser | `src/engine/GCodeParser.ts` |
| Playback UI | `src/components/PlaybackControls.tsx` |
