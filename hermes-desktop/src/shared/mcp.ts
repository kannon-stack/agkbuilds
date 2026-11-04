import type { ToolPolicy } from './toolMeta'

export type McpTransportKind = 'stdio' | 'http' | 'sse'

/** Renderer-safe view of a server config. Secret values (env, headers) are never included. */
export interface McpServer {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  /** Names only — values live encrypted in the main process. */
  envKeys: string[]
  headerKeys: string[]
  /** Default permission for every tool from this server. */
  policy: ToolPolicy
  /** Per-tool overrides keyed by the server's own tool name. */
  toolPolicies: Record<string, ToolPolicy>
}

/** What the renderer sends to create/update a server. */
export interface McpServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  /** Set or replace these env vars / headers; anything not mentioned is kept. */
  envSet?: Record<string, string>
  envRemove?: string[]
  headersSet?: Record<string, string>
  headersRemove?: string[]
  policy: ToolPolicy
  toolPolicies?: Record<string, ToolPolicy>
}

export interface McpToolInfo {
  /** The server's own tool name. */
  name: string
  /** Name the model sees (server-prefixed, sanitized, unique). */
  exposedName: string
  description: string
  readOnly?: boolean
}

export type McpState = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerStatus {
  id: string
  state: McpState
  error?: string
  tools: McpToolInfo[]
  serverInfo?: string
  /** Last lines the server wrote to stderr (stdio only) — handy for diagnosing failures. */
  stderr?: string
}

export interface McpImportResult {
  servers: McpServerInput[]
  errors: string[]
}

/** Split a command line into argv, honoring simple '…' and "…" quoting and backslash escapes. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) cur += line[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else if (c === '\\' && i + 1 < line.length && line[i + 1] !== '\\' && /\s|["']/.test(line[i + 1])) {
      cur += line[++i]
      has = true
    } else {
      cur += c
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

/** Inverse of splitCommand for display/editing. */
export function joinCommand(command: string, args: string[] = []): string {
  const q = (s: string) => (s === '' || /[\s"'\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s)
  return [command, ...args].map(q).join(' ')
}
