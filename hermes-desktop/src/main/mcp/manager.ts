import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerStatus, McpToolInfo } from '../../shared/mcp'
import type { McpServerRecord, Secret } from '../store'
import { ToolError, clip, type ToolImpl } from '../tools/types'
import { exposedName, formatToolResult, normalizeSchema } from './util'

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const MAX_TOOLS_PER_SERVER = 200

type ListedTool = { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; title?: string } }

interface Conn {
  record: McpServerRecord
  fingerprint: string
  state: McpServerStatus['state']
  error?: string
  client?: Client
  transport?: Transport
  tools: ListedTool[]
  serverInfo?: string
  stderr: string
  /** True while we are the ones closing it (so onclose isn't reported as a failure). */
  closing: boolean
  connecting?: Promise<void>
}

export interface McpDeps {
  decrypt(s?: Secret): string | undefined
}

const fingerprint = (r: McpServerRecord) =>
  JSON.stringify([r.enabled, r.transport, r.command, r.args, r.url, r.env, r.headers])

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })

export class McpManager {
  private conns = new Map<string, Conn>()
  private order: string[] = []
  onStatus: (s: McpServerStatus[]) => void = () => {}
  /** Working directory for local servers (the chat workspace, else home). Applied at (re)connect. */
  private workspace = ''

  constructor(private deps: McpDeps) {}

  /** Reconcile live connections with the saved config. Fire-and-forget; see settled(). */
  sync(records: McpServerRecord[], workspace = ''): void {
    this.workspace = workspace
    this.order = records.map((r) => r.id)
    const wanted = new Set(records.map((r) => r.id))
    for (const [id, c] of this.conns) if (!wanted.has(id)) void this.disconnect(c).then(() => this.conns.delete(id))

    for (const record of records) {
      const fp = fingerprint(record)
      const existing = this.conns.get(record.id)
      if (existing && existing.fingerprint === fp) {
        existing.record = record // name/policy edits don't need a reconnect
        continue
      }
      const prev = existing ? this.disconnect(existing) : Promise.resolve()
      const conn: Conn = { record, fingerprint: fp, state: record.enabled ? 'connecting' : 'disabled', tools: [], stderr: '', closing: false }
      this.conns.set(record.id, conn)
      if (record.enabled) conn.connecting = prev.then(() => this.connect(conn))
    }
    this.emit()
  }

  restart(id: string): void {
    const c = this.conns.get(id)
    if (!c || !c.record.enabled) return
    const next: Conn = { record: c.record, fingerprint: c.fingerprint, state: 'connecting', tools: [], stderr: '', closing: false }
    this.conns.set(id, next)
    next.connecting = this.disconnect(c).then(() => this.connect(next))
    this.emit()
  }

  /** Resolves when no server is still connecting (or after `ms`). */
  async settled(ms: number): Promise<void> {
    const pending = [...this.conns.values()].map((c) => c.connecting).filter((p): p is Promise<void> => !!p)
    if (!pending.length) return
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, ms))])
  }

  status(): McpServerStatus[] {
    return this.order.flatMap((id) => {
      const c = this.conns.get(id)
      if (!c) return []
      const names = this.nameMap()
      return [{
        id,
        state: c.state,
        error: c.error,
        serverInfo: c.serverInfo,
        stderr: c.stderr.trim() ? c.stderr.trim().slice(-1500) : undefined,
        tools: c.tools.map((t): McpToolInfo => ({
          name: t.name,
          exposedName: names.get(`${id}\u0000${t.name}`) ?? t.name,
          description: t.description ?? '',
          readOnly: t.annotations?.readOnlyHint
        }))
      }]
    })
  }

  /** Stable server-prefixed names, unique across all servers (config order). */
  private nameMap(): Map<string, string> {
    const taken = new Set<string>()
    const out = new Map<string, string>()
    for (const id of this.order) {
      const c = this.conns.get(id)
      if (!c) continue
      for (const t of c.tools) out.set(`${id}\u0000${t.name}`, exposedName(c.record.name, t.name, taken))
    }
    return out
  }

  /** Tools of all connected servers as ToolImpls ready for the chat loop. */
  tools(): ToolImpl[] {
    const names = this.nameMap()
    const out: ToolImpl[] = []
    for (const id of this.order) {
      const c = this.conns.get(id)
      if (!c || c.state !== 'connected') continue
      for (const t of c.tools) {
        const name = names.get(`${id}\u0000${t.name}`)!
        out.push(this.toToolImpl(c, t, name))
      }
    }
    return out
  }

  private toToolImpl(conn: Conn, t: ListedTool, name: string): ToolImpl {
    const server = conn.record.name
    return {
      name,
      external: true,
      label: `${server} · ${t.name}`,
      defaultPolicy: conn.record.toolPolicies[t.name] ?? conn.record.policy,
      description: clip(`[${server}] ${t.description ?? t.annotations?.title ?? t.name}`, 1024),
      parameters: normalizeSchema(t.inputSchema),
      describe: (a) => {
        const args = a && typeof a === 'object' ? JSON.stringify(a) : ''
        return `${server}: ${t.name}${args && args !== '{}' ? ` ${args.length > 90 ? `${args.slice(0, 90)}…` : args}` : ''}`
      },
      run: async (args, ctx) => {
        // Look up the *current* connection: the server may have been restarted since listing.
        const live = this.conns.get(conn.record.id)
        if (!live?.client || live.state !== 'connected') {
          throw new ToolError(`MCP server "${server}" is not connected${live?.error ? ` (${live.error})` : ''}. Restart it in Settings → MCP.`)
        }
        let res: any
        try {
          res = await live.client.callTool({ name: t.name, arguments: args ?? {} }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS })
        } catch (e) {
          if (ctx.signal.aborted) throw new ToolError('Cancelled by user.')
          throw new ToolError(`MCP error from "${server}": ${(e as Error).message}`)
        }
        const text = formatToolResult(res)
        if (res.isError) throw new ToolError(text)
        return text
      }
    }
  }

  private emit() {
    try {
      this.onStatus(this.status())
    } catch {
      /* listener errors must not break connection handling */
    }
  }

  private makeTransport(conn: Conn): Transport {
    const r = conn.record
    const secrets = (m: Record<string, Secret>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, this.deps.decrypt(v) ?? '']).filter(([, v]) => v !== ''))
    if (r.transport === 'stdio') {
      if (!r.command?.trim()) throw new Error('No command configured.')
      const t = new StdioClientTransport({
        command: r.command,
        args: r.args ?? [],
        env: secrets(r.env),
        cwd: this.workspace || os.homedir(),
        stderr: 'pipe'
      })
      t.stderr?.on('data', (d: Buffer) => {
        conn.stderr = (conn.stderr + d.toString('utf8')).slice(-4000)
      })
      return t
    }
    let url: URL
    try {
      url = new URL(r.url ?? '')
    } catch {
      throw new Error('Invalid server URL.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are supported.')
    const requestInit = { headers: secrets(r.headers) }
    return r.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit })
  }

  private async connect(conn: Conn): Promise<void> {
    const fail = (e: unknown) => {
      if (this.conns.get(conn.record.id) !== conn) return // superseded
      conn.state = 'error'
      conn.error = (e as Error)?.message ?? String(e)
      this.emit()
      void this.disconnect(conn)
    }
    try {
      const transport = this.makeTransport(conn)
      const client = new Client({ name: 'talaria', version: '0.1.0' }, { capabilities: {} })
      conn.client = client
      conn.transport = transport

      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          conn.tools = await this.listAll(client)
          this.emit()
        } catch {
          /* keep the previous list */
        }
      })
      client.onclose = () => {
        if (conn.closing || this.conns.get(conn.record.id) !== conn) return
        conn.state = 'error'
        conn.error = 'Connection closed unexpectedly. Restart the server to reconnect.'
        this.emit()
      }

      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      const v = client.getServerVersion()
      conn.serverInfo = v ? `${v.name} ${v.version}` : undefined
      conn.tools = client.getServerCapabilities()?.tools ? await withTimeout(this.listAll(client), CONNECT_TIMEOUT_MS, 'Listing tools') : []
      if (this.conns.get(conn.record.id) !== conn) return void (await this.disconnect(conn))
      conn.state = 'connected'
      conn.error = undefined
      this.emit()
    } catch (e) {
      // Surface the server's own complaint (e.g. "command not found", missing API key) when there is one.
      const tail = conn.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ')
      fail(tail ? new Error(`${(e as Error).message} — ${tail}`) : e)
    }
  }

  private async listAll(client: Client): Promise<ListedTool[]> {
    const all: ListedTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
      all.push(...(page.tools as ListedTool[]))
      cursor = page.nextCursor
    } while (cursor && all.length < MAX_TOOLS_PER_SERVER)
    return all.slice(0, MAX_TOOLS_PER_SERVER)
  }

  private async disconnect(conn: Conn): Promise<void> {
    conn.closing = true
    const c = conn.client
    conn.client = undefined
    if (!c) return
    try {
      await withTimeout(c.close(), 3000, 'Closing')
    } catch {
      /* best effort; the transport kills the child on close */
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((c) => this.disconnect(c)))
    this.conns.clear()
  }
}
