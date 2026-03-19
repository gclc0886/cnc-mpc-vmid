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
xpos, ypos, zpos     → WCS coordinates (part coordinate system)
xhpos, yhpos, zhpos  → MCS coordinates (machine coordinate system)
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
| `xhpos, yhpos, zhpos` | MCS coordinates (machine system) | Reference only |
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
