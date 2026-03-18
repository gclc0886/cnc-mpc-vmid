import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { WebSocketServer, WebSocket } from 'ws'

const BRIDGE_PORT = parseInt(process.env.CNC_BRIDGE_PORT ?? '3100')
const TIMEOUT_MS = 5000

// --- WebSocket Bridge ---

let browserClient: WebSocket | null = null
let requestId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

const wss = new WebSocketServer({ port: BRIDGE_PORT })

wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[cnc-mcp] Port ${BRIDGE_PORT} already in use — kill the old process or set CNC_BRIDGE_PORT`)
  } else {
    console.error(`[cnc-mcp] WS error:`, err.message)
  }
})

wss.on('connection', (ws) => {
  browserClient = ws
  console.error(`[cnc-mcp] Browser connected on :${BRIDGE_PORT}`)

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    } catch { /* ignore malformed */ }
  })

  ws.on('close', () => {
    if (browserClient === ws) {
      browserClient = null
      console.error('[cnc-mcp] Browser disconnected')
    }
  })
})

console.error(`[cnc-mcp] WebSocket server listening on :${BRIDGE_PORT}`)

function sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!browserClient || browserClient.readyState !== WebSocket.OPEN) {
      reject(new Error('CNC Trainer не подключен. Откройте приложение в браузере (http://localhost:5173)'))
      return
    }
    const id = ++requestId
    pending.set(id, { resolve, reject })
    browserClient.send(JSON.stringify({ id, method, params: params ?? {} }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`Timeout: браузер не ответил за ${TIMEOUT_MS}ms`))
      }
    }, TIMEOUT_MS)
  })
}

// --- MCP Server ---

const server = new McpServer({
  name: 'cnc-trainer',
  version: '1.0.0',
})

// ===== Group A: State Reading =====

server.tool('get_machine_state', 'Get full machine state: config name, axes, positions, MCS/WCS coordinates', {}, async () => {
  const result = await sendCommand('get_machine_state')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

server.tool('get_axis_positions', 'Get current values of all axes (mm/degrees)', {}, async () => {
  const result = await sendCommand('get_axis_positions')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

server.tool('get_matrices', 'Get all transformation matrices (formatted 4x4)', {}, async () => {
  const result = await sendCommand('get_matrices')
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
})

server.tool('get_tool_position', 'Get tool tip position in MCS and WCS coordinates', {}, async () => {
  const result = await sendCommand('get_tool_position')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

server.tool('get_config', 'Get full KinematicConfig JSON', {}, async () => {
  const result = await sendCommand('get_config')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

// ===== Group B: Machine Control =====

server.tool('load_preset', 'Load a machine preset', {
  key: z.enum(['3x', '4x', '5x_ac', '5x_bc', 'turn_mill']).describe('Preset key'),
}, async ({ key }) => {
  await sendCommand('load_preset', { key })
  return { content: [{ type: 'text', text: `Loaded preset: ${key}` }] }
})

server.tool('load_vmid', 'Load VMID XML content into the simulator', {
  xml: z.string().describe('VMID XML content'),
}, async ({ xml }) => {
  const result = await sendCommand('load_vmid', { xml })
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

server.tool('set_axis_value', 'Set a single axis position', {
  name: z.string().describe('Axis name (X, Y, Z, A, B, C)'),
  value: z.number().describe('Value in mm (linear) or degrees (rotary)'),
}, async ({ name, value }) => {
  await sendCommand('set_axis_value', { name, value })
  return { content: [{ type: 'text', text: `Set ${name} = ${value}` }] }
})

server.tool('set_axes', 'Set multiple axis positions at once', {
  axes: z.record(z.string(), z.number()).describe('Object {axisName: value}'),
}, async ({ axes }) => {
  await sendCommand('set_axes', { axes })
  return { content: [{ type: 'text', text: `Set axes: ${JSON.stringify(axes)}` }] }
})

server.tool('reset_axes', 'Reset all axes to zero', {}, async () => {
  await sendCommand('reset_axes')
  return { content: [{ type: 'text', text: 'All axes reset to zero' }] }
})

// ===== Group C: G-code =====

server.tool('load_gcode', 'Load G-code text into the editor', {
  gcode: z.string().describe('G-code program text'),
}, async ({ gcode }) => {
  await sendCommand('load_gcode', { gcode })
  return { content: [{ type: 'text', text: `Loaded ${gcode.split('\n').length} lines of G-code` }] }
})

server.tool('parse_gcode', 'Parse the current G-code and generate tool path', {}, async () => {
  const result = await sendCommand('parse_gcode')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

// ===== Group D: Animation =====

server.tool('play_animation', 'Start animation playback', {}, async () => {
  await sendCommand('play_animation')
  return { content: [{ type: 'text', text: 'Animation started' }] }
})

server.tool('pause_animation', 'Pause animation', {}, async () => {
  await sendCommand('pause_animation')
  return { content: [{ type: 'text', text: 'Animation paused' }] }
})

server.tool('set_animation_step', 'Jump to a specific animation step', {
  step: z.number().int().min(0).describe('Step index'),
}, async ({ step }) => {
  await sendCommand('set_animation_step', { step })
  return { content: [{ type: 'text', text: `Jumped to step ${step}` }] }
})

server.tool('get_animation_state', 'Get current animation state', {}, async () => {
  const result = await sendCommand('get_animation_state')
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
})

// ===== Group E: Configuration =====

server.tool('update_axis_config', 'Modify axis properties (vector, offset, limits)', {
  axisName: z.string().describe('Axis name to update'),
  changes: z.object({
    type: z.enum(['linear', 'rotary', 'static']).optional(),
    vector: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    offset: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    limits: z.object({ min: z.number(), max: z.number() }).optional(),
    center: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  }).describe('Partial axis definition changes'),
}, async ({ axisName, changes }) => {
  await sendCommand('update_axis_config', { axisName, changes })
  return { content: [{ type: 'text', text: `Updated axis ${axisName}` }] }
})

server.tool('add_axis', 'Add a new axis to a device', {
  parentAxisName: z.string().describe('Parent axis name (empty string for root)'),
  deviceId: z.number().int().describe('Device ID (0=spindle, 1=table)'),
  axis: z.object({
    name: z.string(),
    type: z.enum(['linear', 'rotary', 'static']),
    vector: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    limits: z.object({ min: z.number(), max: z.number() }),
  }).describe('New axis definition'),
}, async ({ parentAxisName, deviceId, axis }) => {
  const fullAxis = { ...axis, id: Date.now(), homeRef: 0 }
  await sendCommand('add_axis', { parentAxisName, deviceId, axis: fullAxis })
  return { content: [{ type: 'text', text: `Added axis ${axis.name}` }] }
})

server.tool('add_device', 'Add a new device (spindle/table) with axes', {
  device: z.object({
    name: z.string().describe('Device name, e.g. "Spindle 2"'),
    type: z.enum(['spindle', 'table']).describe('Device type'),
    axes: z.array(z.object({
      name: z.string(),
      type: z.enum(['linear', 'rotary', 'static']),
      vector: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      limits: z.object({ min: z.number(), max: z.number() }),
    })).describe('Root axes for this device'),
  }).describe('Device definition'),
}, async ({ device }) => {
  await sendCommand('add_device', { device })
  return { content: [{ type: 'text', text: `Added device ${device.name} (${device.type}) with ${device.axes.length} axes` }] }
})

server.tool('remove_axis', 'Remove an axis from the configuration', {
  axisName: z.string().describe('Axis name to remove'),
}, async ({ axisName }) => {
  await sendCommand('remove_axis', { axisName })
  return { content: [{ type: 'text', text: `Removed axis ${axisName}` }] }
})

// --- Start ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[cnc-mcp] MCP server running on stdio')
}

main().catch((err) => {
  console.error('[cnc-mcp] Fatal:', err)
  process.exit(1)
})
