import type { KinematicConfig } from '../engine/KinematicChain'

/** 3-Axis Mill: Base → Z → Tool | Base → X → Y → Workpiece */
export const PRESET_3X: KinematicConfig = {
  name: '3-Axis Mill',
  type: 'milling',
  kinematic: 'No-Rotary',
  axisCount: 3,
  linearAxes: ['X', 'Y', 'Z'],
  rotaryAxes: [],
  devices: [
    {
      id: 1, name: 'Spindle', type: 'spindle', maxSpin: 10000,
      axes: [{
        name: 'Z', id: 3, type: 'linear',
        vector: { x: 0, y: 0, z: 1 },
        offset: { x: 0, y: 0, z: 200 },
        homeRef: 0,
        limits: { min: -200, max: 400 },
      }],
    },
    {
      id: 2, name: 'Table', type: 'table', maxSpin: 0,
      axes: [{
        name: 'X', id: 1, type: 'linear',
        vector: { x: 1, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: -300, max: 300 },
        children: [{
          name: 'Y', id: 2, type: 'linear',
          vector: { x: 0, y: 1, z: 0 },
          offset: { x: 0, y: 0, z: -50 },
          homeRef: 0,
          limits: { min: -200, max: 200 },
        }],
      }],
    },
  ],
  combinations: [{
    id: 1, name: 'Spindle_Table', turretId: 1, tableId: 2,
    axesOrder: { linear: [1, 2, 3], rotary: [] },
  }],
  postprocessor: 'sample_3x',
}

/** 4-Axis Mill: Base → Z → Tool | Base → X → Y → A(rot X) → Workpiece */
export const PRESET_4X: KinematicConfig = {
  name: '4-Axis Mill (A-axis)',
  type: 'milling',
  kinematic: 'Table-Table',
  axisCount: 4,
  linearAxes: ['X', 'Y', 'Z'],
  rotaryAxes: ['A'],
  devices: [
    {
      id: 1, name: 'Spindle', type: 'spindle', maxSpin: 12000,
      axes: [{
        name: 'Z', id: 3, type: 'linear',
        vector: { x: 0, y: 0, z: 1 },
        offset: { x: 0, y: 0, z: 200 },
        homeRef: 0,
        limits: { min: -200, max: 400 },
      }],
    },
    {
      id: 2, name: 'Table', type: 'table', maxSpin: 0,
      axes: [{
        name: 'X', id: 1, type: 'linear',
        vector: { x: 1, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: -300, max: 300 },
        children: [{
          name: 'Y', id: 2, type: 'linear',
          vector: { x: 0, y: 1, z: 0 },
          offset: { x: 0, y: 0, z: -50 },
          homeRef: 0,
          limits: { min: -200, max: 200 },
          children: [{
            name: 'A', id: 4, type: 'rotary',
            vector: { x: 1, y: 0, z: 0 },
            offset: { x: 0, y: 0, z: -40 },
            homeRef: 0,
            limits: { min: -360, max: 360 },
          }],
        }],
      }],
    },
  ],
  combinations: [{
    id: 1, name: 'Spindle_Table', turretId: 1, tableId: 2,
    axesOrder: { linear: [1, 2, 3], rotary: [4] },
  }],
  postprocessor: 'sample_4x',
}

/** 5-Axis Trunnion (AC Table-Table): Base → Z → Tool | Base → X → Y → A(tilt) → C(rot) → Workpiece */
export const PRESET_5X_TRUNNION: KinematicConfig = {
  name: '5-Axis Trunnion (AC)',
  type: 'milling',
  kinematic: 'Table-Table',
  axisCount: 5,
  linearAxes: ['X', 'Y', 'Z'],
  rotaryAxes: ['A', 'C'],
  devices: [
    {
      id: 1, name: 'Spindle', type: 'spindle', maxSpin: 15000,
      axes: [{
        name: 'Z', id: 3, type: 'linear',
        vector: { x: 0, y: 0, z: 1 },
        offset: { x: 0, y: 0, z: 250 },
        homeRef: 0,
        limits: { min: -200, max: 500 },
      }],
    },
    {
      id: 2, name: 'Table', type: 'table', maxSpin: 0,
      axes: [{
        name: 'X', id: 1, type: 'linear',
        vector: { x: 1, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: -400, max: 400 },
        children: [{
          name: 'Y', id: 2, type: 'linear',
          vector: { x: 0, y: 1, z: 0 },
          offset: { x: 0, y: 0, z: -50 },
          homeRef: 0,
          limits: { min: -300, max: 300 },
          children: [{
            name: 'A', id: 4, type: 'rotary',
            vector: { x: 1, y: 0, z: 0 },
            offset: { x: 0, y: 0, z: -40 },
            homeRef: 0,
            limits: { min: -120, max: 120 },
            children: [{
              name: 'C', id: 5, type: 'rotary',
              vector: { x: 0, y: 0, z: 1 },
              offset: { x: 0, y: 0, z: -40 },
              homeRef: 0,
              limits: { min: -360, max: 360 },
            }],
          }],
        }],
      }],
    },
  ],
  combinations: [{
    id: 1, name: 'Spindle_Table', turretId: 1, tableId: 2,
    axesOrder: { linear: [1, 2, 3], rotary: [4, 5] },
  }],
  postprocessor: 'sample_5x_ac',
}

/** 5-Axis Head-Head (BC): Base → Y → X → Z → B(tilt) → C(rot) → Tool | Base → Table → Workpiece */
export const PRESET_5X_HEADHEAD: KinematicConfig = {
  name: '5-Axis Head-Head (BC)',
  type: 'milling',
  kinematic: 'Head-Head',
  axisCount: 5,
  linearAxes: ['X', 'Y', 'Z'],
  rotaryAxes: ['B', 'C'],
  devices: [
    {
      id: 1, name: 'Spindle', type: 'spindle', maxSpin: 18000,
      axes: [{
        name: 'Y', id: 2, type: 'linear',
        vector: { x: 0, y: 1, z: 0 },
        offset: { x: 0, y: 0, z: 300 },
        homeRef: 0,
        limits: { min: -300, max: 300 },
        children: [{
          name: 'X', id: 1, type: 'linear',
          vector: { x: 1, y: 0, z: 0 },
          offset: { x: 0, y: 0, z: -80 },
          homeRef: 0,
          limits: { min: -400, max: 400 },
          children: [{
            name: 'Z', id: 3, type: 'linear',
            vector: { x: 0, y: 0, z: 1 },
            offset: { x: 0, y: 0, z: -80 },
            homeRef: 0,
            limits: { min: -200, max: 500 },
            children: [{
              name: 'B', id: 4, type: 'rotary',
              vector: { x: 0, y: 1, z: 0 },
              offset: { x: 0, y: 0, z: -60 },
              homeRef: 0,
              limits: { min: -120, max: 120 },
              children: [{
                name: 'C', id: 5, type: 'rotary',
                vector: { x: 0, y: 0, z: 1 },
                offset: { x: 0, y: 0, z: -50 },
                homeRef: 0,
                limits: { min: -360, max: 360 },
              }],
            }],
          }],
        }],
      }],
    },
    {
      id: 2, name: 'Table', type: 'table', maxSpin: 0,
      axes: [{
        name: 'TABLE', id: 6, type: 'static',
        vector: { x: 0, y: 0, z: 0 },
        offset: { x: 0, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: 0, max: 0 },
      }],
    },
  ],
  combinations: [{
    id: 1, name: 'Spindle_Table', turretId: 1, tableId: 2,
    axesOrder: { linear: [1, 2, 3], rotary: [4, 5] },
  }],
  postprocessor: 'sample_5x_bc',
}

/** Turn-Mill: Base → Z → Y → X → Tool | Base → C(rot Z) → Workpiece
 *  X is deepest linear → tool approaches radially along X.
 *  Rearrange in configurator to Z→X→Y if tool should approach along Y. */
export const PRESET_TURNMILL: KinematicConfig = {
  name: 'Turn-Mill (XZYC)',
  type: 'turn_mill',
  kinematic: 'Turn-Mill',
  axisCount: 4,
  linearAxes: ['X', 'Y', 'Z'],
  rotaryAxes: ['C'],
  devices: [
    {
      id: 1, name: 'Turret', type: 'spindle', maxSpin: 6000,
      axes: [{
        name: 'Z', id: 3, type: 'linear',
        vector: { x: 0, y: 0, z: 1 },
        offset: { x: 150, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: -300, max: 300 },
        children: [{
          name: 'Y', id: 2, type: 'linear',
          vector: { x: 0, y: 1, z: 0 },
          offset: { x: 0, y: 0, z: -50 },
          homeRef: 0,
          limits: { min: -100, max: 100 },
          children: [{
            name: 'X', id: 1, type: 'linear',
            vector: { x: 1, y: 0, z: 0 },
            offset: { x: 0, y: 0, z: -40 },
            homeRef: 0,
            limits: { min: -200, max: 200 },
          }],
        }],
      }],
    },
    {
      id: 2, name: 'Main Spindle', type: 'table', maxSpin: 4000,
      axes: [{
        name: 'C', id: 4, type: 'rotary',
        vector: { x: 0, y: 0, z: 1 },
        offset: { x: 0, y: 0, z: 0 },
        homeRef: 0,
        limits: { min: -36000, max: 36000 },
      }],
    },
  ],
  combinations: [{
    id: 1, name: 'Turret_Spindle', turretId: 1, tableId: 2,
    axesOrder: { linear: [1, 2, 3], rotary: [4] },
  }],
  postprocessor: 'sample_turnmill',
}

/** All presets indexed by key. */
export const PRESETS: Record<string, KinematicConfig> = {
  '3x': PRESET_3X,
  '4x': PRESET_4X,
  '5x_ac': PRESET_5X_TRUNNION,
  '5x_bc': PRESET_5X_HEADHEAD,
  'turn_mill': PRESET_TURNMILL,
}

export const PRESET_NAMES: { key: string; label: string }[] = [
  { key: '3x', label: '3-Axis Mill' },
  { key: '4x', label: '4-Axis Mill (A)' },
  { key: '5x_ac', label: '5-Axis Trunnion (AC)' },
  { key: '5x_bc', label: '5-Axis Head-Head (BC)' },
  { key: 'turn_mill', label: 'Turn-Mill (XZYC)' },
]
