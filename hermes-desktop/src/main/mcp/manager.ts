import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { CallbackServer, NeedsInteractiveAuth, OAuthStore, TalariaOAuthProvider } from './oauth'
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
  /** User pressed Sign in: this connection may open the browser and register a client. */
  interactive?: boolean
  provider?: TalariaOAuthProvider
  connecting?: Promise<void>
}

export interface McpDeps {
  decrypt(s?: Secret): string | undefined
}

export interface OAuthDeps {
  store: OAuthStore
  callback: CallbackServer
  openBrowser(url: string): Promise<void>
}

/** The user-visible outcome of a failed/cancelled sign-in (not a crash). */
class AuthFlowError extends Error {}

const isAuthError = (e: unknown): boolean =>
  e instanceof UnauthorizedError || e instanceof NeedsInteractiveAuth || (e as { code?: number })?.code === 401 || /\b401\b|unauthori[sz]ed/i.test((e as Error)?.message ?? '')

const fingerprint = (r: McpServerRecord) =>
  JSON.stringify([r.enabled, r.transport, r.command, r.args, r.url, r.env, r.headers, r.oauth])

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

  private oauth?: OAuthDeps

  constructor(private deps: McpDeps) {}

  /** Enable OAuth for remote servers (call once the user-data dir is known). */
  initOAuth(o: OAuthDeps): void {
    this.oauth = o
  }

  /** Reconcile live connections with the saved config. Fire-and-forget; see settled(). */
  sync(records: McpServerRecord[], workspace = ''): void {
    this.workspace = workspace
    this.order = records.map((r) => r.id)
    const wanted = new Set(records.map((r) => r.id))
    for (const [id, c] of this.conns) {
      if (wanted.has(id)) continue
      void this.disconnect(c).then(() => this.conns.delete(id))
      void this.oauth?.store.clear(id, 'all') // a removed server must not leave tokens behind
    }

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

  restart(id: string, interactive = false): void {
    const c = this.conns.get(id)
    if (!c || !c.record.enabled) return
    const next: Conn = { record: c.record, fingerprint: c.fingerprint, state: 'connecting', tools: [], stderr: '', closing: false, interactive }
    this.conns.set(id, next)
    next.connecting = this.disconnect(c).then(() => this.connect(next))
    this.emit()
  }

  /** Start the browser sign-in for a remote server (opens the system browser; resolves via settled()). */
  signIn(id: string): void {
    const c = this.conns.get(id)
    if (c && c.record.transport !== 'stdio') this.restart(id, true)
  }

  /** Forget this server's tokens and client registration, then reconnect (it will ask for sign-in again). */
  async signOut(id: string): Promise<void> {
    await this.oauth?.store.clear(id, 'all')
    this.restart(id)
  }

  cancelAuth(id: string): void {
    this.conns.get(id)?.provider?.cancel('Sign-in was cancelled.')
  }

  reopenAuth(id: string): Promise<void> {
    return this.conns.get(id)?.provider?.reopen() ?? Promise.resolve()
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
        signedIn: c.record.transport !== 'stdio' ? !!this.oauth?.store.hasTokens(id) : undefined,
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
          if (isAuthError(e)) {
            // Token refresh failed: surface "sign in again" instead of a cryptic transport error.
            live.state = 'needs_auth'
            live.error = 'Your sign-in expired. Sign in again.'
            this.emit()
            throw new ToolError(`MCP server "${server}" needs you to sign in again (Settings → MCP).`)
          }
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

  private makeTransport(conn: Conn, authProvider?: TalariaOAuthProvider): Transport {
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
    return r.transport === 'sse' ? new SSEClientTransport(url, { requestInit, authProvider }) : new StreamableHTTPClientTransport(url, { requestInit, authProvider })
  }

  private needsAuth(conn: Conn, message?: string) {
    if (this.conns.get(conn.record.id) !== conn) return
    conn.state = 'needs_auth'
    conn.error = message ?? 'This server requires you to sign in.'
    this.emit()
    void this.disconnect(conn)
  }

  private manualOAuth(r: McpServerRecord) {
    return r.oauth ? { clientId: r.oauth.clientId || undefined, clientSecret: this.deps.decrypt(r.oauth.clientSecret), scope: r.oauth.scope || undefined } : undefined
  }

  private async connect(conn: Conn): Promise<void> {
    const fail = (e: unknown) => {
      if (this.conns.get(conn.record.id) !== conn) return // superseded
      conn.state = 'error'
      conn.error = (e as Error)?.message ?? String(e)
      this.emit()
      void this.disconnect(conn)
    }
    const id = conn.record.id
    const remote = conn.record.transport !== 'stdio'
    const oauth = this.oauth
    let acquired = false

    // One connection attempt (fresh Client + transport — a failed one can't be reused).
    const attempt = async (provider?: TalariaOAuthProvider) => {
      const transport = this.makeTransport(conn, provider)
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
        if (conn.closing || conn.client !== client || this.conns.get(id) !== conn) return
        conn.state = 'error'
        conn.error = 'Connection closed unexpectedly. Restart the server to reconnect.'
        this.emit()
      }
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      return client
    }

    try {
      // OAuth is only in play when the user asked to sign in, or tokens already exist (silent refresh).
      let provider: TalariaOAuthProvider | undefined
      if (remote && oauth && (conn.interactive || oauth.store.hasTokens(id))) {
        if (conn.interactive) {
          await oauth.callback.acquire()
          acquired = true
        }
        provider = new TalariaOAuthProvider({
          serverId: id, store: oauth.store, callback: oauth.callback, interactive: !!conn.interactive,
          openBrowser: oauth.openBrowser, manual: this.manualOAuth(conn.record)
        })
        conn.provider = provider
      }

      let client: Client
      try {
        client = await attempt(provider)
      } catch (e) {
        if (!isAuthError(e)) throw e
        if (!conn.interactive || !provider) return this.needsAuth(conn)
        // Interactive: the browser is open (or the server needs a manually registered app). Wait for the redirect.
        let code: string
        try {
          conn.state = 'authorizing'
          conn.error = undefined
          this.emit()
          code = await provider.waitForCode()
        } catch (waitErr) {
          throw new AuthFlowError((waitErr as Error).message)
        }
        const failedTransport = conn.transport as unknown as { finishAuth(code: string): Promise<void> }
        await failedTransport.finishAuth(code)
        const failedClient = conn.client
        client = await attempt(provider)
        void failedClient?.close().catch(() => {}) // the pre-sign-in client is dead weight; its onclose is ignored (see attempt)
      }

      const v = client.getServerVersion()
      conn.serverInfo = v ? `${v.name} ${v.version}` : undefined
      conn.tools = client.getServerCapabilities()?.tools ? await withTimeout(this.listAll(client), CONNECT_TIMEOUT_MS, 'Listing tools') : []
      if (this.conns.get(id) !== conn) return void (await this.disconnect(conn))
      conn.state = 'connected'
      conn.error = undefined
      provider?.settle() // from now on: refresh silently, never pop a browser window on our own
      this.emit()
    } catch (e) {
      if (e instanceof AuthFlowError) return this.needsAuth(conn, e.message)
      if (isAuthError(e)) return this.needsAuth(conn)
      if (/dynamic client registration/i.test((e as Error)?.message ?? '')) {
        return fail(new Error("This server doesn't support automatic app registration. Add a Client ID (and secret, if it has one) under “OAuth settings” for this server, using the redirect URI shown there."))
      }
      // Surface the server's own complaint (e.g. "command not found", missing API key) when there is one.
      const tail = conn.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ')
      fail(tail ? new Error(`${(e as Error).message} — ${tail}`) : e)
    } finally {
      if (acquired) oauth!.callback.release()
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
    conn.provider?.cancel('Connection was replaced.')
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
