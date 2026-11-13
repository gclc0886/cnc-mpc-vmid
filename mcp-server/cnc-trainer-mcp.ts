import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { WebSocketServer, WebSocket } from 'ws'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  BridgeMethod, BridgeParams, BridgeResult, BridgeControl,
} from '../src/api/bridge-types.ts'

const BRIDGE_PORT = parseInt(process.env.CNC_BRIDGE_PORT ?? '3100')
const DEFAULT_TIMEOUT_MS = 10000
const PORT_RETRY_MS = 5000

const log = (...args: unknown[]) => console.error('[cnc-mcp]', ...args)

// ═══════════════════════════════════════════════════════════════
//  WebSocket bridge to the app
//
//  Only one MCP server can own the port. A newer instance (new Claude Code
//  session) asks the current owner to release it ("takeover"); the owner then
//  stops serving and its tools report that another session took over.
//  Without this, a server left behind by a closed session kept the port and
//  the new session silently had no connection to the app.
// ═══════════════════════════════════════════════════════════════

type BridgeState = 'starting' | 'listening' | 'port_busy' | 'released'

let state: BridgeState = 'starting'
let wss: WebSocketServer | null = null
let appClient: WebSocket | null = null
let requestId = 0
let retryTimer: NodeJS.Timeout | null = null
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

function rejectAllPending(reason: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(reason))
    pending.delete(id)
  }
}

function listen(): Promise<boolean> {
  return new Promise((done) => {
    const server = new WebSocketServer({ port: BRIDGE_PORT })
    server.once('listening', () => {
      wss = server
      state = 'listening'
      log(`WebSocket bridge listening on :${BRIDGE_PORT}`)
      done(true)
    })
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') log('WS error:', err.message)
      server.close()
      done(false)
    })
    server.on('connection', onConnection)
  })
}

function onConnection(ws: WebSocket) {
  ws.on('message', (data) => {
    let msg: { id?: number; result?: unknown; error?: string } & Partial<BridgeControl>
    try { msg = JSON.parse(data.toString()) } catch { return }

    if (msg.control === 'takeover') {
      log('Another MCP server instance took over the bridge port — releasing it')
      release()
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    }
  })

  // The app connects and waits for commands; a takeover client sends its message
  // immediately. Treat every connection as the app until it says otherwise.
  appClient = ws
  log('Client connected')
  ws.on('close', () => {
    if (appClient === ws) {
      appClient = null
      rejectAllPending('Приложение отключилось во время выполнения команды')
      log('App disconnected')
    }
  })
}

/** Ask the instance currently holding the port to release it. */
function requestTakeover(): Promise<void> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`)
    const finish = () => { try { ws.terminate() } catch { /* ignore */ } done() }
    const t = setTimeout(finish, 1500)
    ws.on('open', () => {
      const msg: BridgeControl = { control: 'takeover' }
      ws.send(JSON.stringify(msg))
    })
    ws.on('close', () => { clearTimeout(t); finish() })
    ws.on('error', () => { clearTimeout(t); finish() })
  })
}

async function startBridge() {
  if (await listen()) return
  log(`Port ${BRIDGE_PORT} is busy — asking the previous instance to release it`)
  await requestTakeover()
  await new Promise(r => setTimeout(r, 300))
  if (await listen()) return
  state = 'port_busy'
  log(`Port ${BRIDGE_PORT} is still busy (an older server version or another program). Retrying every ${PORT_RETRY_MS / 1000}s.`)
  scheduleRetry()
}

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setInterval(async () => {
    if (state !== 'port_busy') return
    if (await listen()) {
      clearInterval(retryTimer!)
      retryTimer = null
    }
  }, PORT_RETRY_MS)
  retryTimer.unref()
}

function release() {
  state = 'released'
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
  rejectAllPending('Мост передан другой сессии Claude Code')
  for (const c of wss?.clients ?? []) c.terminate()
  wss?.close()
  wss = null
  appClient = null
}

function notConnectedMessage(): string {
  switch (state) {
    case 'port_busy':
      return `Порт ${BRIDGE_PORT} занят другим процессом (вероятно, старый экземпляр cnc-trainer MCP). ` +
        `Найти: netstat -ano | findstr :${BRIDGE_PORT}, завершить: taskkill /PID <pid> /F. Сервер переподключится сам.`
    case 'released':
      return 'Мост к CNC Trainer перехвачен другой сессией Claude Code. Перезапустите MCP-сервер в этой сессии, чтобы вернуть его.'
    default:
      return 'CNC Trainer не подключен. Запустите приложение (npm start или CNC-Trainer.bat) и дождитесь зелёной точки в тулбаре.'
  }
}

function sendCommand<M extends BridgeMethod>(
  method: M,
  params: BridgeParams<M>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BridgeResult<M>> {
  return new Promise((resolve, reject) => {
    if (state !== 'listening' || !appClient || appClient.readyState !== WebSocket.OPEN) {
      reject(new Error(notConnectedMessage()))
      return
    }
    const id = ++requestId
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Timeout: приложение не ответило за ${timeoutMs} мс (${method})`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    appClient.send(JSON.stringify({ id, method, params }))
  })
}

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const json = (v: unknown) => text(typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/**
 * Read a text file whose encoding we don't control: SolidCAM VMIDs are often
 * ISO-8859-1, G-code from Russian setups is often Windows-1251.
 */
async function readTextFile(path: string, fallback: 'latin1' | 'windows-1251'): Promise<string> {
  const buf = await readFile(resolve(path))
  const head = buf.subarray(0, 200).toString('latin1')
  if (/encoding\s*=\s*"(ISO-8859-1|latin1)"/i.test(head)) return new TextDecoder('latin1').decode(buf)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder(fallback).decode(buf)
  }
}

// ═══════════════════════════════════════════════════════════════
//  MCP tools
// ═══════════════════════════════════════════════════════════════

const server = new McpServer({ name: 'cnc-trainer', version: '1.1.0' })

// ===== Group A: State Reading =====

server.tool('get_machine_state', 'Get full machine state: name, category, axis positions, tool tip (MCS/WCS), limit violations, playback status', {},
  async () => json(await sendCommand('get_machine_state', {})))

server.tool('get_axis_positions', 'Get current values of all axes (mm/degrees)', {},
  async () => json(await sendCommand('get_axis_positions', {})))

server.tool('get_matrices', 'Get all world transformation matrices plus the relative Inv(Table)×Tool matrix (formatted 4x4)', {},
  async () => json(await sendCommand('get_matrices', {})))

server.tool('get_tool_position', 'Get tool tip position: MCS (world) and WCS (in the table/workpiece leaf frame, no work offset)', {},
  async () => json(await sendCommand('get_tool_position', {})))

server.tool('get_config', 'Get full KinematicConfig JSON (devices, axes, combinations, channels, access patterns)', {},
  async () => json(await sendCommand('get_config', {})))

// ===== Group B: Machine Control =====

server.tool('load_preset', 'Load a machine preset', {
  key: z.enum(['3x', '4x', '5x_ac', '5x_bc', 'turn_mill']).describe('Preset key'),
}, async ({ key }) => json(await sendCommand('load_preset', { key })))

server.tool('load_vmid', 'Load VMID XML content into the simulator. Prefer load_vmid_file for files on disk.', {
  xml: z.string().describe('VMID XML content'),
}, async ({ xml }) => json(await sendCommand('load_vmid', { xml }, 30000)))

server.tool('load_vmid_file', 'Read a VMID file from disk (handles ISO-8859-1/UTF-8) and load it into the simulator', {
  path: z.string().describe('Absolute path to the .vmid file'),
}, async ({ path }) => {
  const xml = await readTextFile(path, 'latin1')
  return json(await sendCommand('load_vmid', { xml }, 30000))
})

server.tool('set_axis_value', 'Set a single axis position (jog: clamped to limits)', {
  name: z.string().describe('Axis name as in get_config (e.g. X, Y, Z, A, C-1)'),
  value: z.number().describe('Value in mm (linear) or degrees (rotary)'),
}, async ({ name, value }) => {
  await sendCommand('set_axis_value', { name, value })
  return text(`Set ${name} = ${value}`)
})

server.tool('set_axes', 'Set multiple axis positions at once (jog: clamped to limits)', {
  axes: z.record(z.string(), z.number()).describe('Object {axisName: value}'),
}, async ({ axes }) => {
  await sendCommand('set_axes', { axes })
  return text(`Set axes: ${JSON.stringify(axes)}`)
})

server.tool('reset_axes', 'Reset all axes to zero', {}, async () => {
  await sendCommand('reset_axes', {})
  return text('All axes reset to zero')
})

// ===== Group C: G-code =====

server.tool('load_gcode', 'Load G-code text into the editor. Prefer load_gcode_file for files on disk.', {
  gcode: z.string().describe('G-code program text'),
}, async ({ gcode }) => {
  await sendCommand('load_gcode', { gcode }, 30000)
  return text(`Loaded ${gcode.split('\n').length} lines of G-code`)
})

server.tool('load_gcode_file', 'Read a G-code file from disk (UTF-8 or Windows-1251) into the editor, optionally parse it', {
  path: z.string().describe('Absolute path to the program (.mpf, .spf, .nc, ...)'),
  parse: z.boolean().optional().describe('Parse after loading (default true)'),
}, async ({ path, parse }) => {
  const gcode = await readTextFile(path, 'windows-1251')
  await sendCommand('load_gcode', { gcode }, 30000)
  const lines = gcode.split('\n').length
  if (parse === false) return text(`Loaded ${lines} lines from ${path}`)
  const res = await sendCommand('parse_gcode', {}, 60000)
  return json({ path, lines, ...res })
})

server.tool('parse_gcode', 'Parse the current G-code and generate the tool path', {},
  async () => json(await sendCommand('parse_gcode', {}, 60000)))

// ===== Group D: Animation =====

server.tool('play_animation', 'Start animation playback', {}, async () => {
  await sendCommand('play_animation', {})
  return text('Animation started')
})

server.tool('pause_animation', 'Pause animation', {}, async () => {
  await sendCommand('pause_animation', {})
  return text('Animation paused')
})

server.tool('set_animation_step', 'Move the machine to a tool-path step and return the step info (source line, programmed and physical axis values, limit violations, TCP)', {
  step: z.number().int().min(0).describe('Step index'),
}, async ({ step }) => json(await sendCommand('set_animation_step', { step })))

server.tool('get_animation_state', 'Get current animation state', {},
  async () => json(await sendCommand('get_animation_state', {})))

server.tool('get_step_info', 'Inspect a tool-path step without moving the machine: source line, programmed X..C, mapped physical axes, limit violations. TCP is included only for the current step.', {
  step: z.number().int().min(0).optional().describe('Step index (default: current step)'),
}, async ({ step }) => json(await sendCommand('get_step_info', { step })))

// ===== Group E: Configuration =====

server.tool('update_axis_config', 'Modify axis properties (type, vector, offset, limits, center)', {
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
  return text(`Updated axis ${axisName}`)
})

server.tool('add_axis', 'Add a new axis to a device', {
  parentAxisName: z.string().describe('Parent axis name (empty string for a root axis of the device)'),
  deviceId: z.number().int().describe('Device ID from get_config (presets: 1 = spindle/turret, 2 = table)'),
  axis: z.object({
    name: z.string(),
    type: z.enum(['linear', 'rotary', 'static']),
    vector: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    limits: z.object({ min: z.number(), max: z.number() }),
  }).describe('New axis definition'),
}, async ({ parentAxisName, deviceId, axis }) => {
  const fullAxis = { ...axis, id: Date.now(), homeRef: 0 }
  await sendCommand('add_axis', { parentAxisName, deviceId, axis: fullAxis })
  return text(`Added axis ${axis.name}`)
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
  return text(`Added device ${device.name} (${device.type}) with ${device.axes.length} axes`)
})

server.tool('remove_axis', 'Remove an axis from the configuration', {
  axisName: z.string().describe('Axis name to remove'),
}, async ({ axisName }) => {
  await sendCommand('remove_axis', { axisName })
  return text(`Removed axis ${axisName}`)
})

// ===== Group F: View =====

server.tool('capture_screenshot', 'Capture the CNC Trainer window as an image (Electron only)', {
  width: z.number().int().min(200).max(4000).optional().describe('Max image width in px (default 1200)'),
}, async ({ width }) => {
  const res = await sendCommand('capture_screenshot', { width }, 15000)
  return { content: [{ type: 'image' as const, data: res.data, mimeType: res.mimeType }] }
})

// ═══════════════════════════════════════════════════════════════
//  Lifecycle
// ═══════════════════════════════════════════════════════════════

let shuttingDown = false
function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  log(`Shutting down (${reason})`)
  release()
  // Give ws a moment to close sockets, then exit regardless
  setTimeout(() => process.exit(0), 200).unref()
}

async function main() {
  const transport = new StdioServerTransport()
  // Exit when Claude Code closes our stdio; otherwise the WS server keeps the
  // process (and port 3100) alive after the session ends.
  transport.onclose = () => shutdown('stdio closed')
  process.stdin.on('end', () => shutdown('stdin ended'))
  process.stdin.on('close', () => shutdown('stdin closed'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await server.connect(transport)
  log('MCP server running on stdio')
  await startBridge()
}

main().catch((err) => {
  log('Fatal:', err)
  process.exit(1)
})
