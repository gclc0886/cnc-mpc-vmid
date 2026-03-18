import type { KinematicConfig, AxisDef, DeviceDef, ChannelDef, AccessPatternDef } from './KinematicChain'

/**
 * Parse VMID XML string into KinematicConfig.
 * Handles both Ver 30 (Components/Axis) and Ver 24 (SubDevices/Axes) formats.
 */
export function parseVMID(xmlString: string): KinematicConfig {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'text/xml')
  const root = doc.documentElement

  const name = root.getAttribute('Name') || ''
  const version = parseInt(root.getAttribute('Ver') || '24')
  const operationType = parseInt(root.getAttribute('OperationType') || '0')

  const isV30 = version >= 30

  const config: KinematicConfig = {
    name,
    type: operationType === 4 ? 'turn_mill' : 'milling',
    kinematic: 'unknown',
    axisCount: 0,
    linearAxes: [],
    rotaryAxes: [],
    devices: [],
    combinations: [],
    channels: [],
    accessPatterns: [],
    postprocessor: '',
  }

  // Postprocessor
  const ppElem = root.querySelector('PostProcessor')
  if (ppElem) config.postprocessor = ppElem.getAttribute('Name') || ''

  // Parse devices
  if (isV30) {
    parseV30Devices(root, config)
  } else {
    parseV24Devices(root, config)
  }

  // Count axes
  const allAxes = flattenAllAxes(config)
  config.axisCount = allAxes.length
  config.linearAxes = allAxes.filter(a => a.type === 'linear').map(a => a.name)
  config.rotaryAxes = allAxes.filter(a => a.type === 'rotary').map(a => a.name)

  // Determine kinematic type
  const hasRotaryInSpindle = config.devices
    .filter(d => d.type === 'spindle')
    .some(d => flattenAxes(d.axes).some(a => a.type === 'rotary'))
  const hasRotaryInTable = config.devices
    .filter(d => d.type === 'table')
    .some(d => flattenAxes(d.axes).some(a => a.type === 'rotary'))

  if (hasRotaryInSpindle && hasRotaryInTable) config.kinematic = 'Head-Table'
  else if (hasRotaryInTable) config.kinematic = 'Table-Table'
  else if (hasRotaryInSpindle) config.kinematic = 'Head-Head'
  else config.kinematic = 'No-Rotary'

  // Combinations
  const combos = root.querySelectorAll('Combination')
  combos.forEach(c => {
    const ao = c.querySelector('AxesOrder')
    const linear: number[] = []
    const rotary: number[] = []

    if (isV30 && ao) {
      // Ver 30: AxisOrder children
      ao.querySelectorAll('AxisOrder').forEach((item, idx) => {
        const aid = parseInt(item.getAttribute('AxisId') || '-1')
        if (aid >= 0) {
          if (idx < 3) linear.push(aid); else rotary.push(aid)
        }
      })
    } else if (ao) {
      // Ver 24: L1/L2/L3/R1/R2/R3
      for (const key of ['L1', 'L2', 'L3']) {
        const v = parseInt(ao.getAttribute(key) || '-1')
        if (v >= 0) linear.push(v)
      }
      for (const key of ['R1', 'R2', 'R3']) {
        const v = parseInt(ao.getAttribute(key) || '-1')
        if (v >= 0) rotary.push(v)
      }
    }

    config.combinations.push({
      id: parseInt(c.getAttribute('ID') || '0'),
      name: c.getAttribute('Name') || '',
      turretId: parseInt(c.getAttribute('TurretID') || '0'),
      tableId: parseInt(c.getAttribute('TableID') || '0'),
      axesOrder: { linear, rotary },
    })
  })

  // Channels
  parseChannels(root, config)

  // Access Patterns
  parseAccessPatterns(root, config)

  return config
}

function parseChannels(root: Element, config: KinematicConfig) {
  const channelsElem = root.querySelector('Channels')
  if (!channelsElem) return

  for (const ch of Array.from(channelsElem.querySelectorAll(':scope > Channel'))) {
    const submachineIds: number[] = []
    const smIds = ch.querySelector('SubmachinesIds')
    if (smIds) {
      for (const attr of Array.from(smIds.attributes)) {
        if (attr.name.startsWith('Id')) {
          const v = parseInt(attr.value)
          if (v >= 0) submachineIds.push(v)
        }
      }
    }

    config.channels.push({
      id: parseInt(ch.getAttribute('ID') || '0'),
      name: ch.getAttribute('Name') || '',
      submachineIds,
      numLinearAxes: parseInt(ch.getAttribute('NumLinearAxes') || '0'),
      numRotaryAxes: parseInt(ch.getAttribute('NumRotaryAxes') || '0'),
    })
  }
}

function parseAccessPatterns(root: Element, config: KinematicConfig) {
  const apElem = root.querySelector('AccessPatterns')
  if (!apElem) return

  for (const ap of Array.from(apElem.querySelectorAll(':scope > AccessPattern'))) {
    const permissions: Record<number, string> = {}
    for (const axis of Array.from(ap.querySelectorAll('Axis'))) {
      const axId = parseInt(axis.getAttribute('Id') || axis.getAttribute('ID') || '0')
      const mode = axis.getAttribute('Mode') || 'normal'
      permissions[axId] = mode
    }

    config.accessPatterns.push({
      id: parseInt(ap.getAttribute('ID') || '0'),
      name: ap.getAttribute('Name') || '',
      axisPermissions: permissions,
    })
  }
}

function parseV30Devices(root: Element, config: KinematicConfig) {
  // V30: Axes nested in Components, Device elements are INSIDE the axis tree.
  // Walk each root axis subtree to find which Device it leads to (Spindle=Type2, Table=Type1).
  const components = root.querySelector(':scope > Components')
  if (!components) return

  const spindleAxes: AxisDef[] = []
  const tableAxes: AxisDef[] = []
  let spindleId = 0
  let spindleName = 'Spindle'
  let spindleMaxSpin = 0
  let tableId = 0
  let tableName = 'Table'

  for (const child of Array.from(components.children)) {
    if (child.tagName === 'Axis') {
      const deviceType = findDeviceTypeInTree(child)
      const axisDef = parseAxisV30(child)
      if (deviceType === 'table') {
        tableAxes.push(axisDef)
        // Extract table device info
        const dev = findDeviceElement(child, '1')
        if (dev) {
          tableId = parseInt(dev.getAttribute('ID') || '0')
          tableName = dev.getAttribute('Name') || 'Table'
        }
      } else {
        // Default to spindle chain (or if contains spindle device, or unknown)
        spindleAxes.push(axisDef)
        const dev = findDeviceElement(child, '2')
        if (dev) {
          spindleId = parseInt(dev.getAttribute('ID') || '0')
          spindleName = dev.getAttribute('Name') || 'Spindle'
          // Find max spin from Gear elements
          const gear = dev.querySelector('Gear')
          if (gear) spindleMaxSpin = parseFloat(gear.getAttribute('MaxSpin') || '0')
        }
      }
    }
  }

  config.devices.push({
    id: spindleId || 1,
    name: spindleName,
    type: 'spindle',
    maxSpin: spindleMaxSpin,
    axes: spindleAxes,
  })

  // Only add table device if we found table axes or a table device element
  if (tableAxes.length > 0 || tableId > 0) {
    config.devices.push({
      id: tableId || 2,
      name: tableName,
      type: 'table',
      maxSpin: 0,
      axes: tableAxes,
    })
  } else {
    // Fallback: check for top-level Device[Type="1"] (no axes on table)
    const tableDevs = root.querySelectorAll(':scope > Device[Type="1"]')
    if (tableDevs.length === 0) {
      // No table device found at all — create a static one
      config.devices.push({
        id: 2,
        name: 'Table',
        type: 'table',
        maxSpin: 0,
        axes: [{ name: 'TABLE', id: 9999, type: 'static', vector: { x: 0, y: 0, z: 0 }, homeRef: 0, limits: { min: 0, max: 0 } }],
      })
    } else {
      tableDevs.forEach(d => {
        config.devices.push({
          id: parseInt(d.getAttribute('ID') || '0'),
          name: d.getAttribute('Name') || 'Table',
          type: 'table',
          maxSpin: 0,
          axes: [],
        })
      })
    }
  }
}

/** Recursively check if an axis subtree contains a Device of given type */
function findDeviceTypeInTree(elem: Element): 'spindle' | 'table' | null {
  // Check immediate children and nested Components for Device elements
  for (const child of Array.from(elem.querySelectorAll('Device'))) {
    const type = child.getAttribute('Type')
    if (type === '1' || type === '10') return 'table'  // Type 1=Table, 10=Station(table)
    if (type === '2') return 'spindle'
  }
  return null
}

/** Find a Device element of given type within the axis subtree */
function findDeviceElement(elem: Element, deviceType: string): Element | null {
  return elem.querySelector(`Device[Type="${deviceType}"]`)
}

function parseV24Devices(root: Element, config: KinematicConfig) {
  const subDevs = root.querySelector(':scope > SubDevices')
  if (!subDevs) return

  for (const sd of Array.from(subDevs.querySelectorAll(':scope > SubDevice'))) {
    const devType = parseInt(sd.getAttribute('Type') || '0')
    const axes: AxisDef[] = []

    const axesElem = sd.querySelector(':scope > Axes')
    if (axesElem) {
      for (const axElem of Array.from(axesElem.querySelectorAll(':scope > Axis'))) {
        axes.push(parseAxisV24(axElem))
      }
    }

    const dev = {
      id: parseInt(sd.getAttribute('ID') || '0'),
      name: sd.getAttribute('Name') || '',
      type: devType === 2 ? 'spindle' : 'table',
      maxSpin: parseFloat(sd.getAttribute('MaxSpin') || '0'),
      axes,
      coordSys: parseCoordSys(sd),
    }
    config.devices.push(dev)
  }
}

function parseAxisV30(elem: Element): AxisDef {
  const ax: AxisDef = {
    name: elem.getAttribute('Name') || '',
    id: parseInt(elem.getAttribute('ID') || '0'),
    type: parseInt(elem.getAttribute('Type') || '0') === 1 ? 'rotary' : 'linear',
    vector: {
      x: parseFloat(elem.getAttribute('VecX') || '0'),
      y: parseFloat(elem.getAttribute('VecY') || '0'),
      z: parseFloat(elem.getAttribute('VecZ') || '0'),
    },
    homeRef: parseFloat(elem.getAttribute('HomeRef') || '0'),
    limits: {
      min: parseFloat(elem.getAttribute('MinLim') || '-100000'),
      max: parseFloat(elem.getAttribute('MaxLim') || '100000'),
    },
  }

  if (ax.type === 'rotary') {
    ax.center = {
      x: parseFloat(elem.getAttribute('CenterX') || '0'),
      y: parseFloat(elem.getAttribute('CenterY') || '0'),
      z: parseFloat(elem.getAttribute('CenterZ') || '0'),
    }
  }

  const components = elem.querySelector(':scope > Components')
  if (components) {
    ax.children = []
    for (const child of Array.from(components.querySelectorAll(':scope > Axis'))) {
      ax.children.push(parseAxisV30(child))
    }
  }

  return ax
}

function parseAxisV24(elem: Element): AxisDef {
  const ax: AxisDef = {
    name: elem.getAttribute('Name') || '',
    id: parseInt(elem.getAttribute('Id') || '0'),
    type: parseInt(elem.getAttribute('Type') || '0') === 1 ? 'rotary' : 'linear',
    vector: {
      x: parseFloat(elem.getAttribute('VecX') || '0'),
      y: parseFloat(elem.getAttribute('VecY') || '0'),
      z: parseFloat(elem.getAttribute('VecZ') || '0'),
    },
    homeRef: parseFloat(elem.getAttribute('HomeRef') || '0'),
    limits: {
      min: parseFloat(elem.getAttribute('MinLim') || '-100000'),
      max: parseFloat(elem.getAttribute('MaxLim') || '100000'),
    },
  }

  if (ax.type === 'rotary') {
    ax.center = {
      x: parseFloat(elem.getAttribute('CenterX') || '0'),
      y: parseFloat(elem.getAttribute('CenterY') || '0'),
      z: parseFloat(elem.getAttribute('CenterZ') || '0'),
    }
  }

  const children = elem.querySelector(':scope > AxisChildren')
  if (children) {
    ax.children = []
    for (const child of Array.from(children.querySelectorAll(':scope > Axis'))) {
      ax.children.push(parseAxisV24(child))
    }
  }

  return ax
}

/**
 * Export KinematicConfig back to VMID XML (Ver 58 format).
 */
export function exportVMID(config: KinematicConfig): string {
  const opType = config.type === 'turn_mill' ? '4' : '0'
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
  xml += `<Machine Isvmid="1" Ver="58" ID="1" Name="${esc(config.name)}" `
  xml += `OperationType="${opType}" FullyConverted="1">`

  // Components (axes)
  xml += '<Components>'
  for (const dev of config.devices) {
    for (const axis of dev.axes) {
      xml += axisToXml(axis, dev)
    }
  }
  xml += '</Components>'

  // PostProcessor
  if (config.postprocessor) {
    xml += `<PostProcessors><PostProcessor Name="${esc(config.postprocessor)}"/></PostProcessors>`
  }

  // Combinations
  if (config.combinations.length > 0) {
    xml += '<Combinations>'
    for (const combo of config.combinations) {
      xml += `<Combination ID="${combo.id}" Ver="10" Name="${esc(combo.name)}" `
      xml += `TurretID="${combo.turretId}" TableID="${combo.tableId}" OperationType="0">`
      xml += '<AxesOrder>'
      for (const id of combo.axesOrder.linear) {
        xml += `<AxisOrder AxisId="${id}" UsedInMillingAs="2" UsedInTurningAs="2" UsedInWireEdmAs="0"/>`
      }
      for (const id of combo.axesOrder.rotary) {
        xml += `<AxisOrder AxisId="${id}" UsedInMillingAs="2" UsedInTurningAs="0" UsedInWireEdmAs="0"/>`
      }
      xml += '</AxesOrder></Combination>'
    }
    xml += '</Combinations>'
  }

  // Channels
  if (config.channels.length > 0) {
    xml += '<Channels>'
    for (const ch of config.channels) {
      xml += `<Channel ID="${ch.id}" Name="${esc(ch.name)}" NumLinearAxes="${ch.numLinearAxes}" NumRotaryAxes="${ch.numRotaryAxes}">`
      if (ch.submachineIds.length > 0) {
        xml += '<SubmachinesIds'
        ch.submachineIds.forEach((id, i) => { xml += ` Id${i}="${id}"` })
        xml += '/>'
      }
      xml += '</Channel>'
    }
    xml += '</Channels>'
  }

  // Access Patterns
  if (config.accessPatterns.length > 0) {
    xml += '<AccessPatterns>'
    for (const ap of config.accessPatterns) {
      xml += `<AccessPattern ID="${ap.id}" Name="${esc(ap.name)}">`
      for (const [axId, mode] of Object.entries(ap.axisPermissions)) {
        xml += `<Axis Id="${axId}" Mode="${mode}"/>`
      }
      xml += '</AccessPattern>'
    }
    xml += '</AccessPatterns>'
  }

  xml += '</Machine>\n'
  return xml
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function axisToXml(axis: AxisDef, dev: { type: string; id: number; name: string; maxSpin: number }): string {
  const typeNum = axis.type === 'rotary' ? 1 : 0
  let xml = `<Axis Ver="11" ID="${axis.id}" Name="${esc(axis.name)}" Type="${typeNum}"`
  xml += ` VecX="${axis.vector.x}" VecY="${axis.vector.y}" VecZ="${axis.vector.z}"`
  if (axis.offset && (axis.offset.x || axis.offset.y || axis.offset.z)) {
    xml += ` OffsetX="${axis.offset.x}" OffsetY="${axis.offset.y}" OffsetZ="${axis.offset.z}"`
  }
  if (axis.type === 'rotary' && axis.center) {
    xml += ` CenterX="${axis.center.x}" CenterY="${axis.center.y}" CenterZ="${axis.center.z}"`
  }
  xml += ` HomeRef="${axis.homeRef}" MinLim="${axis.limits.min}" MaxLim="${axis.limits.max}"`
  xml += ` InterpolationStep="0.001" Rapid="10000" MinSpeed="0" MaxSpeed="5000"`
  xml += ` Acceleration="2500" Deceleration="2500">`

  // Children or Device leaf
  if (axis.children && axis.children.length > 0) {
    xml += '<Components>'
    for (const child of axis.children) {
      xml += axisToXml(child, dev)
    }
    xml += '</Components>'
  } else {
    // Leaf axis — embed Device element
    const devType = dev.type === 'spindle' ? '2' : '1'
    xml += '<Components>'
    xml += `<Device Ver="20" ID="${dev.id}" Name="${esc(dev.name)}" DeviceNumber="1" Type="${devType}" DriveUnitType="1">`
    xml += `<Gears><Gear Ver="1" MinSpin="0" MaxSpin="${dev.maxSpin}" Power="15"/></Gears>`
    xml += `<Coord x="0" y="0" z="0"/>`
    xml += `<CoordSysVecX x="1" y="0" z="0"/><CoordSysVecY x="0" y="1" z="0"/><CoordSysVecZ x="0" y="0" z="1"/>`
    xml += `<CoordSysPlace x="0" y="0" z="0"/>`
    xml += '</Device></Components>'
  }

  xml += '</Axis>'
  return xml
}

function parseCoordSys(elem: Element): DeviceDef['coordSys'] {
  const vx = elem.querySelector(':scope > CoordSysVecX')
  const vy = elem.querySelector(':scope > CoordSysVecY')
  const vz = elem.querySelector(':scope > CoordSysVecZ')
  const pl = elem.querySelector(':scope > CoordSysPlace')
  if (!vx && !vy && !vz && !pl) return undefined

  return {
    vecX: {
      x: parseFloat(vx?.getAttribute('x') || '1'),
      y: parseFloat(vx?.getAttribute('y') || '0'),
      z: parseFloat(vx?.getAttribute('z') || '0'),
    },
    vecY: {
      x: parseFloat(vy?.getAttribute('x') || '0'),
      y: parseFloat(vy?.getAttribute('y') || '1'),
      z: parseFloat(vy?.getAttribute('z') || '0'),
    },
    vecZ: {
      x: parseFloat(vz?.getAttribute('x') || '0'),
      y: parseFloat(vz?.getAttribute('y') || '0'),
      z: parseFloat(vz?.getAttribute('z') || '1'),
    },
    place: {
      x: parseFloat(pl?.getAttribute('x') || '0'),
      y: parseFloat(pl?.getAttribute('y') || '0'),
      z: parseFloat(pl?.getAttribute('z') || '0'),
    },
  }
}

function flattenAxes(axes: AxisDef[]): AxisDef[] {
  const result: AxisDef[] = []
  for (const ax of axes) {
    result.push(ax)
    if (ax.children) result.push(...flattenAxes(ax.children))
  }
  return result
}

function flattenAllAxes(config: KinematicConfig): AxisDef[] {
  const all: AxisDef[] = []
  for (const dev of config.devices) {
    all.push(...flattenAxes(dev.axes))
  }
  return all
}
