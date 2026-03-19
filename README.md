# CNC Kinematic Simulator / Trainer

Visual-mathematical simulator of multi-axis CNC machine kinematics with MCP (Model Context Protocol) integration for AI-assisted control.

![Electron + React + Three.js](https://img.shields.io/badge/stack-Electron%20%7C%20React%20%7C%20Three.js-blue)
![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## What is this?

CNC Trainer lets you build, visualize and simulate CNC machine kinematics — from simple 3-axis mills to complex multi-turret Mill-Turn centers. It connects to **Claude Code** via MCP, giving an AI agent full control over the simulator: loading machines, moving axes, running G-code, inspecting transformation matrices, and more.

### Key Features

- **Forward Kinematics Engine** — 4x4 transformation matrices, dual chains (tool + workpiece), TCP calculation in MCS/WCS
- **3D Visualization** — interactive Three.js viewport with machine model, protractor discs on rotary axes, toolpath rendering
- **G-code Simulation** — Sinumerik-compatible parser (G0/G1/G2/G3, IJK/R/CR= arcs, G17-G19 planes, G90/G91)
- **VMID Format** — full import/export of SolidCAM Virtual Machine ID files (Ver 24–58), including sub-machines, channels, and access patterns
- **MCP Integration** — 21 tools for AI-driven machine inspection, configuration, and simulation
- **Sub-machine Axis Mapping** — Mill-Turn support with multiple turret/table combinations and G-code coordinate mapping
- **5 Built-in Presets** — 3-axis, 4-axis, 5-axis Table-Table, 5-axis Head-Head, Turn-Mill

## Architecture

```
Claude Code  <-->  MCP Server (stdio, Node.js)
                       |
                  WebSocket :3100
                       |
                  Electron / Browser (React)
                       |
                  Zustand Store <-> KinematicChain Engine
```

| Layer | File | Role |
|-------|------|------|
| MCP Server | `mcp-server/cnc-trainer-mcp.ts` | 21 tools, WebSocket relay to app |
| Bridge Client | `src/api/BridgeClient.ts` | Browser-side WS client |
| State Store | `src/store/useMachineStore.ts` | Central state (Zustand) |
| Kinematic Engine | `src/engine/KinematicChain.ts` | Forward kinematics, matrix math |
| G-code Parser | `src/engine/GCodeParser.ts` | G0/G1/G2/G3, IJK/R/CR= arcs |
| VMID Loader | `src/engine/VMIDLoader.ts` | SolidCAM VMID import/export |
| 3D Renderer | `src/visualization/MachineModel.tsx` | Three.js machine model |

## Tech Stack

| | |
|---|---|
| Frontend | React 19 + TypeScript + Vite 8 |
| 3D | Three.js via @react-three/fiber + @react-three/drei |
| State | Zustand 5 |
| Desktop | Electron 41 |
| MCP | @modelcontextprotocol/sdk |
| Transport | WebSocket (port 3100) |

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Install & Run

```bash
# Clone
git clone https://github.com/gclc0886/cnc-mpc-vmid.git
cd cnc-mpc-vmid

# Install dependencies
npm install

# Run in browser
npm run dev
# Open http://localhost:5173

# Run as Electron app
npm start
```

### Connect to Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "cnc-trainer": {
      "command": "npx",
      "args": ["tsx", "mcp-server/cnc-trainer-mcp.ts"],
      "cwd": "/path/to/cnc-mpc-vmid"
    }
  }
}
```

Then start the app first (Electron or browser), wait for the green connection dot, and use MCP tools from Claude Code.

## MCP Tools (21 total)

### Reading State
| Tool | Returns |
|------|---------|
| `get_machine_state` | Full state: name, type, all positions, TCP, playback status |
| `get_axis_positions` | Current axis values (mm / degrees) |
| `get_tool_position` | TCP in MCS and WCS coordinates |
| `get_matrices` | All 4x4 transformation matrices |
| `get_config` | Full KinematicConfig JSON |
| `get_animation_state` | Current step, total steps, playing status |

### Machine Control
| Tool | Effect |
|------|--------|
| `load_preset` | Load built-in preset (3x, 4x, 5x_ac, 5x_bc, turn_mill) |
| `load_vmid` | Load machine from VMID XML |
| `set_axis_value` | Move single axis |
| `set_axes` | Move multiple axes at once |
| `reset_axes` | Zero all axes |

### G-code & Animation
| Tool | Effect |
|------|--------|
| `load_gcode` | Load G-code into editor |
| `parse_gcode` | Parse & generate toolpath |
| `play_animation` | Start playback |
| `pause_animation` | Pause playback |
| `set_animation_step` | Jump to step |

### Configuration
| Tool | Effect |
|------|--------|
| `update_axis_config` | Modify axis properties |
| `add_axis` | Add axis to device tree |
| `add_device` | Add new device (spindle/table) |
| `remove_axis` | Remove axis |

## Data Model

### Machine Configuration

A machine consists of **devices** (spindle = tool chain, table = workpiece chain), each containing a tree of **axes** (linear, rotary, or static). The kinematic engine computes forward kinematics by walking each chain and composing 4x4 transformation matrices.

### Sub-machines (Combinations)

For Mill-Turn machines, a **Combination** defines a pairing of turret + table with an **axis order** that maps G-code coordinates to physical axes:

```
axesOrder.linear[0] → G-code X
axesOrder.linear[1] → G-code Y
axesOrder.linear[2] → G-code Z
axesOrder.rotary[0] → G-code A
axesOrder.rotary[1] → G-code B
axesOrder.rotary[2] → G-code C
```

### Channels & Access Patterns

- **Channels** — independent axis groups with their own sub-machines (for multi-turret coordination)
- **Access Patterns** — axis exchange modes between channels (`normal` / `forbidden` / `exchange`), used for Swiss-type G140/G142 axis sharing

## VMID Format Support

The VMID (Virtual Machine ID) is SolidCAM's machine definition format. CNC Trainer provides full round-trip support:

- **Import**: Ver 24 (SubDevices) and Ver 30+ (Components)
- **Export**: Ver 58 with full hierarchy
- **Parsed elements**: SubDevices with coordinate systems, axis trees, combinations with axis order, channels, access patterns
- **Round-trip**: Load → Edit → Save preserves all data

## Screenshots

*Launch the app and load a preset or VMID file to see the 3D machine model with interactive axis controls, protractor discs, and toolpath visualization.*

## Use Cases

- **Learning CNC kinematics** — visualize how axes compose to position the tool
- **Debugging VMID files** — load, inspect, and edit SolidCAM machine definitions
- **G-code verification** — simulate toolpaths and check axis movements
- **AI-assisted machine building** — let Claude Code configure machines via MCP
- **Postprocessor development** — verify axis mapping and coordinate transformations
- **Mill-Turn setup** — test sub-machine configurations and axis exchange modes

## License

MIT
