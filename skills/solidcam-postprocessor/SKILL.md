---
name: solidcam-postprocessor
description: >
  Expert skill for analyzing, debugging, and modifying SolidCAM postprocessors (GPPL language).
  Use this skill whenever the user mentions: postprocessor, GPP file, GPPL, trace file,
  4-axis wrapping, 3+2 indexing, 5-axis simultaneous, coordinate transformation, G-code generation,
  SolidCAM output problems, wrong coordinates in G-code, or any CAM-to-machine translation issues.
  Also trigger for: analyzing trace files, fixing axis angle calculations, coordinate system
  transformations (WCS/MCS), rotary axis handling (A/B/C), and any SolidCAM → G-code debugging.
  Trigger even for "постпроцессор", "почему неправильные координаты", "4-ось", "wrapping"
  without mentioning SolidCAM explicitly.
---

# SolidCAM Postprocessor Modification Skill

## Core Philosophy

1. **Always analyze the trace file first** — it contains all variables SolidCAM passes to the postprocessor
2. **Never guess variable values** — find them in the trace or GPPL documentation
3. **Test impact of changes** — fixes for one operation type must not break others
4. **Use SolidCAM's built-in variables** — `dapos`, `rot_axis_type`, `first_axis_angle` already contain correct calculations
5. **Document all changes** — create changelog for every modification

---

## Required Files from User

| File | Required | Description |
|------|----------|-------------|
| `.gpp` | ✅ YES | Postprocessor source code |
| `trace.txt` | ✅ YES | Trace output (enable with `trace 'all'` in GPP) |
| `.vmid` | Recommended | Machine definition file |
| G-code sample | Recommended | Example of incorrect output |
| Expected result | Recommended | What the output should look like |

---

## Analysis Methodology

### Step 1: Identify Operation Type

Search trace file for `@rotary_info`:

```
rot_axis_type:axis4_radial  → WRAPPING (continuous 4-axis)
rot_axis_type:axis4_none    → INDEXING (3+2) or standard 3-axis
rot_axis_type:axis4_polar   → POLAR interpolation
```

### Step 2: Find Key Variables

**For coordinate issues:**
```
xpos, ypos, zpos     → Coordinates in the operation/face CoordSys (local)
xhpos, yhpos, zhpos  → Coordinates in the main part CoordSys at A=0 (NOT machine axis values!)
xmpos, ympos, zmpos  → Transformed coordinates (after matrix)
```

**For angle issues:**
```
apos, bpos, cpos     → Current rotary axis angles
dapos, dbpos, dcpos  → Delta angle (change from previous point)
first_axis_angle     → First rotary axis angle (for indexing)
rotate_angle_x/y/z   → Plane rotation angles
```

### Step 3: Trace the Problem

Compare trace variables with G-code output. Find the procedure that generates wrong output:

```
@rapid_move  → G0 moves
@line        → G1 moves
@move_5x     → 5-axis/wrapping rapid
@line_5x     → 5-axis/wrapping linear
@arc         → G2/G3 arcs
@rotate      → Coordinate rotation
```

---

## Operation Types & Fixes

### INDEXING (3+2 Machining)

**Symptoms:**
- Y/Z coordinates different on each face (should be same in WCS)
- Spurious A-0, A-360 commands in every block
- No safe Z retract before rotation

**Root cause:** Using `yhpos/zhpos` instead of `ypos/zpos`

**Fix pattern:**
```gppl
@calc_clean_4axis
  if rot_axis_type eq axis4_radial then
    ; WRAPPING - use machine coordinates
    y_calc = yhpos
    z_calc = zhpos
  else
    ; INDEXING - use WCS coordinates
    y_calc = ypos
    z_calc = zpos
  endif
endp
```

**Safe rotation pattern:**
```gppl
@start_of_job
  if rot_axis_type ne axis4_radial then
    if change(first_axis_angle) then
      {nb, 'G0 Z'ztool}              ; Safe Z retract
      {nb, 'G0 A'first_axis_angle}   ; Rotate
    endif
  endif
endp
```

#### Case: inverted face CoordSys (Z sign flipped, tool cuts "through the center")

**Symptoms** (DMC635_SIN-4X, rotor, Nov 2026):
- Working Z negative and constant on every face (`Z-50.493` → `G1 Z-48.493`), retract `Z-90` — tool goes below the rotation axis
- Approach goes from more-negative to less-negative Z (tool comes from the face CS **−Z** side)
- A sequence decreasing (168, 156, …) although VMID has `Positive4xDirOnly="1"`

**Diagnosis:** dump variables (see "Diagnostic dump" below). Seen values at the cut point of face 1:
`zpos=-48.493 ypos=0` | `zhpos=47.433 yhpos=-10.082` | `rotate_angle_x=first_axis_angle=168`.
`(yhpos, zhpos)` of the cut and retract points lie on one ray at −12° (radius 48.493 and 90) → the slot is at part angle θ−180. With a right-hand table rotation about +X, A = part angle to bring under the tool = θ−180 = −12 → A348. (First derived as A=12 from CNC-Trainer, whose `Matrix4x4.inverse()` did not invert rotations — mirrored; the symmetric rotor hid it.)

**The side is per CAM job, not per machine.** A second part (hex prism, spiral-milled holes on 6 faces) had the tool on the face CS **+Z** side. A hardcoded flip turned that program into a crash (all Z negative). So the post must decide per face.

**Detection:** the first move of a face goes to the clearance plane, outside the part → the sign of its local `zpos` tells the side.

| Face CS | Y | Z | A | G41/G42 |
|---|---|---|---|---|
| tool on +Z (`zpos > 0` at clearance) | `ypos` | `zpos` | `angle` | as is |
| tool on −Z (`zpos < 0` at clearance) | `-ypos` | `-zpos` | `angle - 180` | swapped (Y mirrored) |

A = angle of the part point brought under the tool (`(yhpos,zhpos) = R·(sin φ, cos φ)`), table turning right-hand about +X. This is the same convention as SolidCAM's own machine angle `apos` in wrapping (dump: `apos=202.051` ↔ `hpos=(-13.139,-32.437)`), so indexing and wrapping agree. Both rows checked numerically on dumps (hex, rotor, cylinder part). Not yet checked on the real machine (MDI `G0 A90`).

**A range (non-modulo axis, DMC635):** indexing outputs the absolute face angle normalized to 0…360, no accumulation (so the table may run back almost a full turn, e.g. `A348 → A0`); wrapping accumulates via `dapos` up to the 3600 limit. The axis counter lives in the control: a post can't "reset" it without motion except with `PRESETON` (rejected by the user).

**Fix pattern (retract + A deferred to the first move of the face):**
```gppl
; @start_of_job (indexing) / @rotate (not cancel): only remember the face
    face_angle = first_axis_angle      ; rotate_angle_x in @rotate
    rot_pending = true

; @calc_clean_4axis, before the angle unwrap
  if rot_pending then
    rot_pending = false
    if zpos < 0 then
      flip_yz = true
      fourth_axis = face_angle - 180
    else
      flip_yz = false
      fourth_axis = face_angle
    endif
    while fourth_axis < 0
      fourth_axis = fourth_axis + 360
    endw
    while fourth_axis >= 359.9995
      fourth_axis = fourth_axis - 360
    endw
    delta_a = fourth_axis - global_a_pos
    if !a_output or delta_a > 0.0001 or delta_a < -0.0001 then
      {nb, 'G0 Z'ztool}
      {nb, 'G0 A'fourth_axis}
      a_output = true
    endif
    global_a_pos = fourth_axis
    global_a_prev = fourth_axis
  endif
  ; indexing coords
  if flip_yz then
    y_calc = 0 - ypos     ; 0 - v, not -v: avoids printing "Y-0"
    z_calc = 0 - zpos
  else
    y_calc = ypos
    z_calc = zpos
  endif
```
`@arc` must call `@calc_clean_4axis` and output `y_calc/z_calc` too (shared `change()` tracking with `@line`), reverse G2/G3 in XY/ZX when `flip_yz` (YZ: both axes flip = rotation, direction kept), and negate J for thread arcs. `@compensation`: swap G41/G42 when `flip_yz`.

Results: rotor (−Z side) `G0 A12` → `G0 X-6 Z90` → `G1 Z48.493` → `G1 X25`, A 348, 336 … 0 (first face rot_x=168 → A348); hex (+Z side) `G0 A0` → `X25.924 Y1.2 Z50` → helix down to Z≈9.9, A 0, 300, 240 … 60 (A = first_axis_angle).

**Do NOT** output `yhpos/zhpos` here — they are part coordinates at A=0, so Y appears and the plunge becomes a tilted Y+Z line.

**Caveat:** on a symmetric part (30 slots × 12°, 180° = 15 pitches) a wrong A mapping is invisible — every face still hits *some* slot. Test with both CS orientations and with an asymmetric feature against the SolidCAM simulation.

**Tool change:** don't pre-position Y from `ynext` in `@change_tool` (face-CS value, wrong sign when flipped); output X/Z only and force Y on the first move — the machine sits at `ytool`, not at the last tracked Y.
`change(y_calc) = true` set in `@change_tool` does **not** survive: the next `y_calc = ...` assignment with an unchanged value resets the flag (seen: `G0 X25.924 Z50` without Y). Set a global flag instead and apply it after the assignment:
```gppl
; @change_tool
  {nb, 'G0 X'xnext, ' Z'ztool}
  force_y = true
; end of @calc_clean_4axis, after y_calc/z_calc are assigned
  if force_y then
    change(y_calc) = true
    force_y = false
  endif
```
Verified on a rotor job where T2 starts at the same Y0 that T1 ended on: `G0 X10 Y0` is now output.

#### Drilling in indexing (Sinumerik MCALL cycles)

Which path SolidCAM takes depends on the VMID `<DrillCycle ... UseCycle>`: `UseCycle="0"` (G81 on DMC635) → plain G0/G1 through `@rapid_move`/`@line` (already mapped); `UseCycle="1"` (G82/83/84/86) → `@drill` + `@drill_point`.

1. **`@drill_point` must always output X Y.** `MCALL CYCLExx(...)` runs only on following blocks *with motion*. `@drill` already positioned on the hole, so a change-only `{nb,['X'xpos],['Y'ypos],['Z'zpos]}` printed an empty block → cycle declared and cancelled, **no hole drilled**:
   ```
   G0 X25.924 Y0
   MCALL CYCLE83(...)
   N9580                 <- empty: nothing drilled
   MCALL
   ```
   Fix: `call @calc_clean_4axis` then `{nb, 'X'xpos, ' Y'y_calc}` (no Z — the cycle handles Z).
2. **Position before computing the cycle Z values.** On a new face the CoordSys side (`flip_yz`) is decided on the first move, so `call @rapid_move` must come first in `@drill`; then negate `rtp/rfp/dp` when `flip_yz`. Otherwise a flipped face gets negative values and trips the `RFP <= DP` FATAL check instead of drilling.
3. **CYCLE83 parameter order (840D):** `CYCLE83(RTP, RFP, SDIS, DP, DPR, FDEP, FDPR, DAM, DTB, DTS, FRF, VARI)`. The old post wrote `(RTP, DP, RFP, FEED, , STEP, , STEP, , , 1, 1)`, which a standard 840D reads as RFP=DP, SDIS=RFP, DP=feed. Now:
   ```gppl
   {'(',rtp,',',rfp,',',sdis,',',dp,',,,',down_step,',',down_step,',,,1,1)'}
   ```
   → `MCALL CYCLE83(50,41.164,2,9,,,5,5,,,1,1)` (step → FDPR and DAM, FRF=1, VARI=1 chip removal). G81/82/84/86 in the same post already used the standard order — compare cycles within one post when one looks odd.

See: `references/indexing-fixes.md`

---

### WRAPPING (Continuous 4-Axis)

**Principle:**
```
Flat toolpath → Wrapped on cylinder:
X → X (along cylinder axis)
Y → A (rotation angle, Y=0 always!)
Z → Z (radial distance from axis)
```

**Symptoms:**
- Y ≠ 0 in output
- Z shows machine coordinates instead of radius
- Angle A inverted or miscalculated
- Spirals (delta > 180°) produce wrong angles

**Fix pattern:**
```gppl
@move_5x
  ; Angle accumulation using dapos from SolidCAM
  fourth_axis = apos
  wrap_delta_a = dapos
  call @calc_wrap_angle
  
  y_wrap = 0  ; Y always 0 for wrapping
  
  {nb, 'G0'}
  {[' X'xpos]}
  {[' Y'y_wrap]}
  {[' Z'zpos]}      ; Radial distance
  if change(global_a_pos)
     {' A'global_a_pos}
  endif
endp

@calc_wrap_angle
  ; Use dapos directly - handles spirals correctly!
  global_a_pos = global_a_pos + wrap_delta_a
  
  while global_a_pos < 0
      global_a_pos = global_a_pos + 360
  endw
endp
```

**🔴 CRITICAL: Spiral handling**

Old (WRONG for spirals):
```gppl
delta_a = apos - prev_apos
if delta_a > 180
    delta_a = delta_a - 360   ; Breaks spirals with delta > 180°!
endif
```

New (CORRECT):
```gppl
; Use dapos directly from SolidCAM
global_a_pos = global_a_pos + dapos
```

See: `references/wrapping-fixes.md`

---

### 5-AXIS SIMULTANEOUS

**Key variables:**
```
xmpos, ympos, zmpos  → Transformed tip coordinates
apos, bpos           → Tool orientation angles
xpos_normal, ypos_normal, zpos_normal → Tool axis vector
```

**Common issues:**
- Wrong RTCP/TCP transformation
- Singularity near vertical tool orientation
- Axis limits not handled

See: `references/5axis-patterns.md`

---

## GPPL Syntax Reference

### Variable Declaration
```gppl
global numeric var1 var2       ; Global numeric variables
global string str1             ; Global string
global logical flag1           ; Global boolean
local numeric temp             ; Local to procedure
```

### Output Syntax
```gppl
{' X'xpos}           ; Always output
{[' X'xpos]}         ; Output only if changed
{nb}                 ; Block number
{nb, 'G0 X'xpos}     ; Block number + content
{'G'gcode}           ; Variable in output
```

### Control Flow
```gppl
if condition then
  ; code
endif

if condition then
  ; code
else
  ; code
endif

while condition
  ; code
endw
```

### Built-in Functions
```gppl
change(variable)     ; Returns TRUE if value changed
active(variable)     ; Returns TRUE if variable is active
abs(value)           ; Absolute value
sin(angle), cos(angle), tan(angle)  ; Trigonometry (degrees)
sqrt(value)          ; Square root
```

### Key Procedures
```gppl
@init_post           ; Initialization, global variables
@start_of_file       ; File header
@start_program       ; Program start
@change_tool         ; Tool change
@start_of_job        ; Operation start
@rotary_info         ; Rotary axis info (type, diameter)
@rapid_move          ; G0 moves
@line                ; G1 moves  
@arc                 ; G2/G3 arcs
@move_5x             ; 5-axis/wrapping rapid
@line_5x             ; 5-axis/wrapping linear
@rotate              ; Coordinate rotation
@end_of_job          ; Operation end
@end_program         ; Program end
@end_of_file         ; File footer
```

See: `references/gppl-syntax.md`

---

## Coordinate Variables Reference

| Variable | Description | Use for |
|----------|-------------|---------|
| `xpos, ypos, zpos` | WCS coordinates (part system) | Indexing, standard |
| `xhpos, yhpos, zhpos` | Main part CoordSys at A=0 (verified on DMC635 indexing: cut point of a face at A168 reads as a point on the −12° ray) — not machine axis values | Locating the feature on the part; wrapping radius |
| `xmpos, ympos, zmpos` | Matrix-transformed coordinates | 5-axis |
| `xopos, yopos, zopos` | Operation coordinate system | Local ops |
| `xlpos, ylpos, zlpos` | Local coordinates | Subroutines |
| `xtpos, ytpos, ztpos` | With tool length compensation | RTCP |
| `apos, bpos, cpos` | Rotary axis angles | All rotary |
| `dapos, dbpos, dcpos` | Angle delta (from previous) | Wrapping, spirals |
| `first_axis_angle` | First rotary angle | Indexing |
| `second_axis_angle` | Second rotary angle | 5-axis indexing |
| `rotate_angle_x/y/z` | Plane rotation angles | Indexing |

---

## Trace Analysis Patterns

### Enable Full Trace
```gppl
@init_post
  trace 'all':0      ; Enable trace for all procedures
endp
```

### Key Sections to Find

**Operation type:**
```
@rotary_info ==> rot_axis_type:axis4_radial radial_diameter:94.000
```

**Coordinate data:**
```
@line_5x ==> xpos:73.000 ypos:0.000 zpos:50.300
         ..> apos:321.524 dapos:0.045
         ..> xhpos:73.000 yhpos:-46.658 zhpos:58.707
```

**Output G-code:**
```
> N130 G0 X73 Y-46.658 Z58.707 A38.476
```

### Diagnostic dump (when no trace file is available)

Put temporary comment output at the end of the coordinate routine, regenerate, read the variables right next to the G-code they produce:
```gppl
  {nb, ';DBG xpos=', xpos, ' ypos=', ypos, ' zpos=', zpos}
  {nb, ';DBG xhpos=', xhpos, ' yhpos=', yhpos, ' zhpos=', zhpos}
  {nb, ';DBG apos=', apos, ' cpos=', cpos, ' rot_ax_x=', rotate_angle_x, ' first_ang=', first_axis_angle, ' rot_type=', rot_axis_type}
```
Remove after diagnosis. Don't guess variable semantics from names — dump them.

### Verify rotary direction against VMID kinematics

Ground truth is the dump, not a simulator: in a wrapping op `apos` is SolidCAM's machine angle and `(yhpos,zhpos)` gives the part angle φ of the same point — their relation is the A convention (here A = φ). Indexing must use the same sign. A third-party kinematic model can be wrong: CNC-Trainer's `Matrix4x4.inverse()` returned a non-inverted rotation and showed the table turning the mirrored way, which produced wrong formulas that symmetric test parts did not expose. Cross-check two sources and the real machine.

### Compare Input vs Output

| Trace Variable | Value | G-code Output | Expected | Issue |
|----------------|-------|---------------|----------|-------|
| ypos | 0.000 | Y-46.658 | Y0 | Using yhpos |
| zpos | 50.300 | Z58.707 | Z50.300 | Using zhpos |
| apos | 321.524 | A38.476 | A321.524 | Inverted |

---

## Common Mistakes Checklist

### Indexing (3+2)
- [ ] Using `yhpos/zhpos` instead of `ypos/zpos`
- [ ] Working Z negative on all faces → tool on the face CS −Z side; detect the side per face from `zpos` at the clearance move (never hardcode the flip — another job can be +Z)
- [ ] Flipped face CS but G41/G42 and G2/G3 not swapped
- [ ] `@arc`/`@drill_point` output raw `ypos/zpos` while `@line` outputs `y_calc/z_calc` (different sign and broken `change()` tracking)
- [ ] Empty block after `MCALL CYCLExx` → holes not drilled; `@drill_point` must force X Y
- [ ] Cycle Z values (RTP/RFP/DP) computed before the face side is known
- [ ] CYCLE83 parameters not in 840D order
- [ ] `change(var) = true` set before a later assignment of the same value (flag lost)
- [ ] Indexed A accumulating across tools (A372, A720…) instead of absolute 0…360
- [ ] Indexing and wrapping using opposite A sign conventions (compare `apos` vs `hpos` angle in a dump; test a part with both op types)
- [ ] First wrapping move after an indexed op: `dapos` is relative to SolidCAM's previous `apos`, start from absolute `apos` instead
- [ ] No safe Z retract before A rotation
- [ ] Outputting A in every block (should be only on face change)
- [ ] Spurious A-0, A-360 commands

### Wrapping
- [ ] Y ≠ 0 (should always be 0)
- [ ] Using `zhpos` instead of `zpos` for radius
- [ ] Manual delta calculation instead of `dapos`
- [ ] 180° wraparound logic breaks spirals
- [ ] Not initializing angle accumulator

### General
- [ ] Redundant coordinate output (use `{[' X'xpos]}`)
- [ ] Missing feed on first G1
- [ ] Wrong axis order for controller
- [ ] Not checking `rot_axis_type` before rotary logic

---

## G-code Optimization

**Good practice:** Output coordinates only when changed.

```gppl
; Instead of:
{'G1 X'xpos, ' Y'ypos, ' Z'zpos, ' F'feed}

; Use:
{'G1'}
{[' X'xpos]}
{[' Y'ypos]}
{[' Z'zpos]}
{[' F'feed]}
```

**Result:**
```gcode
; Before (verbose):
N10 G1 X100 Y50 Z-5 F500
N20 G1 X100 Y50 Z-10 F500
N30 G1 X100 Y60 Z-10 F500

; After (optimized):
N10 G1 X100 Y50 Z-5 F500
N20 G1 Z-10
N30 G1 Y60
```

---

## Debugging Workflow

1. **Get trace file** with `trace 'all':0`
2. **Find problem procedure** (which `@procedure` generates bad output)
3. **Compare variables** (trace input vs G-code output)
4. **Identify wrong variable** (e.g., `yhpos` instead of `ypos`)
5. **Check operation type** (`rot_axis_type`)
6. **Apply fix pattern** from this skill
7. **Test other operations** (don't break what works)
8. **Document changes** in changelog

---

## References

- `references/gppl-syntax.md` — GPPL language quick reference
- `references/coordinate-variables.md` — All coordinate variable types
- `references/indexing-fixes.md` — 3+2 machining fix patterns
- `references/wrapping-fixes.md` — 4-axis wrapping fix patterns
- `references/5axis-patterns.md` — 5-axis simultaneous patterns
- `references/trace-analysis.md` — How to read trace files
