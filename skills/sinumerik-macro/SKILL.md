---
name: sinumerik-macro
description: >
  Expert skill for writing, debugging, and validating CNC programs and macros for
  Siemens Sinumerik controllers (828D, 840D). Use this skill whenever the user mentions:
  G-code, MPF files, SPF subprograms, R-parameters, DEF variables, FOR/IF/WHILE loops,
  ROT/TRANS/SCALE frames, G41/G42 tool radius compensation, cycle programming, postprocessor
  logic, parametric machining, or any Sinumerik-specific syntax. Also trigger for requests
  to write milling/turning macros, hexagon programs, contour cycles, or any CNC automation
  task targeting a Siemens controller. Trigger even if the user just says "напиши макрос"
  or "G-код" without mentioning Sinumerik explicitly — assume Sinumerik unless stated otherwise.
---

# Sinumerik Macro Programming Skill

## Core Philosophy

Always write **true macros** — programs that use variables, arithmetic, and loops.
Never write flat G-code with hardcoded coordinates unless explicitly asked.
The goal: operator changes only the input parameters block, everything else recalculates automatically.

---

## Program Structure (always use this order)

```
БЛОК 1: DEF — объявление всех переменных
БЛОК 2: Чтение входных параметров (R-параметры или константы)
БЛОК 3: Проверка параметров (IF / MSG / M0)
БЛОК 4: Расчёт геометрии
БЛОК 5: Вызов инструмента (T="NAME" M6)
БЛОК 6: Старт (G-модальные, G54/G55, S M3, M8)
БЛОК 7: Рабочий цикл (FOR / WHILE + ROT/TRANS)
БЛОК 8: Завершение (ROT сброс, G40, M9, M5, M30)
```

---

## Variable Declaration

```
DEF REAL _SW          ; always use underscore prefix for user variables
DEF REAL _FEED
DEF INT  _PASSES
DEF INT  _I, _J       ; loop counters
```

**Rules:**
- User variables: underscore prefix `_NAME`
- R-parameters (R0–R249): for operator input via HMI panel
- GUD (Global User Data): for values that persist across programs
- Never use R0–R9 (often reserved by machine builder)

---

## Reading R-Parameters

```
_SW      = R10
_H       = R11
_D_BLANK = R12
_PASSES  = R13         ; INT = R-param assigned to DEF INT works fine
```

Pair with a separate input program `XXX_INPUT.MPF` that uses `MSG + M0` to prompt operator
for each R-parameter. See reference: `references/input-program-pattern.md`

---

## Geometry Calculation Patterns

### Hexagon (6-sided regular polygon)
```
_APOTHEM  = _SW / 2                    ; center to flat face
; Side length = SW / SQRT(3)
; Overrun: always from blank radius, not from SW geometry
_OVERRUN  = _D_BLANK / 2 + 2          ; guaranteed exit past any blank cross-section
_Y_START  = _D_BLANK / 2 + 2          ; approach start (fresa descends in air)
_Y_END    = _APOTHEM                   ; final pass = clean face
_Y_STEP   = (_Y_START - _Y_END) / _PASSES
```

**Critical**: `_OVERRUN` must be calculated from `_D_BLANK`, NOT from SW.
Old formula `(SW/SQRT(3))/2 + 3` gives ~5.3 mm but real blank edge at Y=SW/2 is ~5.7 mm → crash.

### Step calculation sanity check (always verify in comments)
```
; _Y_START=9.0  _Y_END=4.0  PASSES=3  → STEP=1.667
; Pass1: Y=7.333  Pass2: Y=5.667  Pass3: Y=4.000 ✅
```

---

## Tool Radius Compensation (G41/G42)

**The fundamental rule:** G41/G42 requires a movement vector in the XY plane to activate.
The approach vector determines which side the compensation shifts toward.

### Correct approach pattern for face milling (movement along X):

```
; 1. Position: start left of blank, already at Y = programmed line
G0 X=-(_OVERRUN + _D_TOOL / 2 + 2) Y=_Y_CURR

; 2. Descend in air
G0 Z=2
G1 Z=-_H F=_FEED_Z

; 3. Activate G41 WITH movement in +X direction
;    → controller sees vector +X → "left" = +Y → shifts center by +R
G41 G1 X=-_OVERRUN F=_FEED

; 4. Machine the face
G1 X=_OVERRUN F=_FEED

; 5. Cancel G40 WITH movement continuing in +X (smooth exit)
G1 G40 X=(_OVERRUN + _D_TOOL / 2 + 2) F=_FEED

; 6. Retract
G0 Z=_Z_SAFE
```

**Never activate G41 in a Z-only move or with zero XY displacement — controller alarm.**
**Never cancel G40 with G0 in the middle of a contour — always use G1 with an exit vector.**

### Which to use: G41 vs G42

| Movement direction | Left side | Use |
|---|---|---|
| +X (left→right) | +Y (away from you) | G41 |
| -X (right→left) | -Y (toward you) | G41 |
| +Y (bottom→top) | -X | G41 |
| Climb milling (CCW) | — | G41 |
| Conventional milling | — | G42 |

---

## Coordinate Rotation (ROT)

```
ROT Z=60               ; rotate current WCS by 60° around Z
                       ; all subsequent X/Y coordinates are in rotated system
ROT                    ; cancel rotation (no arguments = reset)
```

**For hexagon:** `ROT Z=(_FACE * 60)` inside `FOR _FACE = 0 TO 5` loop.

**Important:** ROT stacks on top of active WCS (G54 etc). After `ROT`, coordinates are
relative to rotated frame. Always reset with bare `ROT` at end of cycle.

---

## Loop Patterns

```
; Count-based
FOR _I = 1 TO _N
  ; body
ENDFOR

; Condition-based
WHILE (_Y_CURR > _Y_END)
  _Y_CURR = _Y_CURR - _STEP
  ; body
ENDWHILE

; Nested (passes × faces)
FOR _PASS = 1 TO _PASSES
  _Y_CURR = _Y_START - _Y_STEP * _PASS
  FOR _FACE = 0 TO 5
    ROT Z=(_FACE * 60)
    ; machine one face
  ENDFOR
ENDFOR
```

---

## Error Checking (Блок 3)

```
IF (_SW >= _D_BLANK)
  MSG("ОШИБКА: SW=" << _SW << " >= D_BLANK=" << _D_BLANK << "!")
  M0                   ; program stop — operator fixes and presses CYCLE START
ENDIF

IF (_H <= 0)
  MSG("ОШИБКА: H должна быть > 0")
  M0
ENDIF

IF (_PASSES <= 0)
  MSG("ОШИБКА: Количество проходов >= 1")
  M0
ENDIF

MSG("")                ; clear message display — all OK
```

**Check order matters:** validate inputs BEFORE any geometry calculation.
MSG concatenation uses `<<` operator. M0 = programmed stop (resumable with CYCLE START).

---

## Tool Call

```
T="TOOL_NAME"          ; call by name from tool magazine table
M6                     ; tool change
G0 Z=_Z_SAFE           ; retract after change
```

Never use `T1 D1` style unless machine is configured for it.
Tool name must exactly match the string in the magazine table.
Radius compensation value is read automatically from the tool's D-offset record.

---

## Modal G-codes Header

```
G17 G90 G94 G21 G54
```

| Code | Meaning | Alternative |
|---|---|---|
| G17 | XY working plane | G18 (XZ), G19 (YZ) |
| G90 | Absolute coordinates | G91 (incremental) |
| G94 | Feed in mm/min | G95 (mm/rev) |
| G21 | Metric (mm) | G20 (inches) |
| G54 | WCS 1 | G55–G59 |

These are redundant on a properly configured machine but explicit declaration
prevents inheriting wrong modal state from a previous program.

---

## Z-approach Pattern (safe descent)

```
G0 Z=_Z_SAFE           ; rapid to safe plane first
G0 X=... Y=...         ; rapid to XY start position (at safe Z)
G0 Z=2                 ; rapid to 2mm above part
G1 Z=-_H F=_FEED_Z     ; controlled plunge
```

Never combine XYZ rapid moves into a single G0 block when approaching a part —
machine may take diagonal path that collides with fixture or clamps.

---

## Common Mistakes to Avoid

| Mistake | Consequence | Fix |
|---|---|---|
| `_OVERRUN` from SW geometry | Doesn't clear blank edge → crash | Use `_D_BLANK / 2 + 2` |
| G41 activated on Z-move | Controller alarm | Always include XY vector |
| `_Y_START = D_BLANK/2` without air gap | Plunge into blank side | Add `+ 2` |
| G40 with G0 | Unpredictable exit path | Use `G1 G40` with exit vector |
| ROT not reset after cycle | Next WCS operation is rotated | Always end with bare `ROT` |
| Hardcoded coordinates | Not reusable | Use DEF variables |
| No input validation | Silent wrong parts | Always add Блок 3 checks |

---

## Calculation Verification Pattern

Always include a comment block showing the arithmetic for the current parameters:

```
; === РАСЧЁТ ДЛЯ ТЕКУЩИХ ПАРАМЕТРОВ ===
; SW=8  D_BLANK=14  PASSES=3
; _APOTHEM  = 8/2         = 4.000 мм
; _OVERRUN  = 14/2 + 2    = 9.000 мм
; _Y_START  = 14/2 + 2    = 9.000 мм
; _Y_END    = 4.000 мм
; _Y_STEP   = (9-4)/3     = 1.667 мм
; Pass1: Y=7.333  Pass2: Y=5.667  Pass3: Y=4.000 ✅
; X_blank_edge at Y=4: sqrt(7²-4²) = 5.745 мм < OVERRUN=9 ✅
```

---

## File Naming Convention

| File | Purpose |
|---|---|
| `FEAT_INPUT.MPF` | Operator parameter entry (R-params via MSG+M0) |
| `FEAT_MACRO.MPF` | Main parametric program |
| `FEAT_CALC.SPF` | Geometry subroutine (if reused by multiple programs) |

---

## References

- `references/input-program-pattern.md` — Full template for HEX_INPUT style programs
- `references/g41-g42-guide.md` — Detailed G41/G42 approach/depart patterns
- `references/sinumerik-syntax.md` — Quick reference: operators, functions, built-ins
