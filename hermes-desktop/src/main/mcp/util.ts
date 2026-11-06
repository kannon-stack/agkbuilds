// Pure helpers for MCP (no Electron/SDK imports) so they are trivially unit-testable.
import { createHash } from 'node:crypto'
import type { McpImportResult, McpServerInput } from '../../shared/mcp'
import { joinCommand, splitCommand } from '../../shared/mcp'
import { clip } from '../tools/types'

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'server'

/**
 * Function names must match ^[a-zA-Z0-9_-]{1,64}$ for OpenAI-style APIs.
 * Produces `<server>__<tool>`, sanitized, ≤64 chars, unique within `taken`.
 */
export function exposedName(serverName: string, toolName: string, taken: Set<string>): string {
  const clean = (x: string) => x.replace(/[^a-zA-Z0-9_-]/g, '_')
  let name = `${slugify(serverName)}__${clean(toolName)}`
  if (name.length > 64) {
    const h = createHash('sha1').update(name).digest('hex').slice(0, 6)
    name = `${name.slice(0, 57)}_${h}`
  }
  let candidate = name
  for (let n = 2; taken.has(candidate); n++) candidate = `${name.slice(0, 60)}_${n}`
  taken.add(candidate)
  return candidate
}

/** Providers require a top-level object schema; MCP servers are usually fine but not always. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : {}
  if (s.type !== 'object') return { type: 'object', properties: {} }
  if (!s.properties) s.properties = {}
  return s
}

interface McpContent {
  type: string
  text?: string
  mimeType?: string
  data?: string
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }
  uri?: string
  name?: string
}

/** Flatten an MCP tool result to text the model can read. */
export function formatToolResult(res: { content?: McpContent[]; structuredContent?: unknown; isError?: boolean }): string {
  const parts: string[] = []
  for (const c of res.content ?? []) {
    if (c.type === 'text') parts.push(c.text ?? '')
    else if (c.type === 'image') parts.push(`[image: ${c.mimeType ?? 'unknown'}, ${Math.round(((c.data?.length ?? 0) * 3) / 4)} bytes — not shown]`)
    else if (c.type === 'audio') parts.push(`[audio: ${c.mimeType ?? 'unknown'} — not shown]`)
    else if (c.type === 'resource' && c.resource) {
      parts.push(c.resource.text ?? `[resource ${c.resource.uri ?? ''}${c.resource.mimeType ? ` (${c.resource.mimeType})` : ''}]`)
    } else if (c.type === 'resource_link') parts.push(`[resource link: ${c.uri ?? c.name ?? ''}]`)
    else parts.push(`[${c.type} content]`)
  }
  let out = parts.join('\n').trim()
  if (!out && res.structuredContent !== undefined) out = JSON.stringify(res.structuredContent, null, 2)
  return clip(out || (res.isError ? 'The tool reported an error without details.' : '(no output)'))
}

/**
 * Parse the de-facto `{ "mcpServers": { name: {...} } }` format used by Claude Desktop,
 * Cursor, VS Code (`servers`), etc. Also accepts a bare `{ name: {...} }` map or one server object.
 */
export function parseImport(text: string): McpImportResult {
  const errors: string[] = []
  let json: any
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { servers: [], errors: [`Not valid JSON: ${(e as Error).message}`] }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { servers: [], errors: ['Expected a JSON object.'] }

  let map: Record<string, any> = json.mcpServers ?? json.servers ?? json
  if (map.command || map.url) map = { server: map } // a single bare server object
  const servers: McpServerInput[] = []

  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') { errors.push(`"${name}": not an object`); continue }
    const kind = String(cfg.type ?? cfg.transport ?? '').toLowerCase()
    const url = cfg.url ?? cfg.serverUrl
    const env = cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) : undefined
    if (cfg.command) {
      // "command" may be a full line ("npx -y pkg") or just the executable with separate args.
      const argv = Array.isArray(cfg.args) ? [String(cfg.command), ...cfg.args.map(String)] : splitCommand(String(cfg.command))
      const [command, ...args] = argv
      if (!command) { errors.push(`"${name}": empty command`); continue }
      servers.push({ name, enabled: true, transport: 'stdio', command, args, envSet: env, policy: 'ask' })
    } else if (typeof url === 'string') {
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
      } catch {
        errors.push(`"${name}": invalid URL`)
        continue
      }
      const headers = cfg.headers && typeof cfg.headers === 'object' ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, String(v)])) : undefined
      servers.push({ name, enabled: true, transport: kind === 'sse' ? 'sse' : 'http', url, headersSet: headers, policy: 'ask' })
    } else {
      errors.push(`"${name}": needs a "command" (local) or "url" (remote)`)
    }
  }
  return { servers, errors }
}

/** One-line description of how a server is launched/reached, for UI and logs. */
export const describeServer = (s: Pick<McpServerInput, 'transport' | 'command' | 'args' | 'url'>) =>
  s.transport === 'stdio' ? joinCommand(s.command ?? '', s.args) : s.url ?? ''
