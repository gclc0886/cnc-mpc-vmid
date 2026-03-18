/** Command sent from MCP server to browser via WebSocket */
export interface BridgeCommand {
  id: number
  method: string
  params: Record<string, unknown>
}

/** Response sent from browser back to MCP server */
export interface BridgeResponse {
  id: number
  result?: unknown
  error?: string
}
