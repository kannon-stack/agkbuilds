import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAUTH_REDIRECT_PORT } from '../../shared/mcp'
import type { Secret } from '../store'

/** OAuth for remote MCP servers: encrypted token store, loopback callback server, and the SDK provider. No Electron imports. */

export interface SecretCrypto {
  encrypt(plain: string): Secret
  decrypt(s?: Secret): string | undefined
}

/** The user must act (sign in) — distinct from a failure. */
export class NeedsInteractiveAuth extends Error {
  constructor(message = 'Sign-in required') {
    super(message)
    this.name = 'NeedsInteractiveAuth'
  }
}

// ---------------------------------------------------------------- token store

type Entry = { client?: Secret; tokens?: Secret; discovery?: unknown }

/**
 * Per-server OAuth credentials in `mcp-oauth.json` (owner-only). Client info and tokens are encrypted with the
 * same OS-keychain path as API keys; reads are served from memory so the SDK's sync-ish provider calls are cheap.
 */
export class OAuthStore {
  private data: Record<string, Entry> = {}
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private file: string, private crypto: SecretCrypto) {}

  async init(): Promise<void> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.data = j && typeof j === 'object' && j.servers && typeof j.servers === 'object' ? j.servers : {}
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
      this.data = {}
    }
  }

  private persist(): Promise<void> {
    const run = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify({ version: 1, servers: this.data }, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmp, this.file)
    })
    this.chain = run.catch(() => {})
    return run
  }

  private read<T>(s?: Secret): T | undefined {
    const plain = this.crypto.decrypt(s)
    if (!plain) return undefined
    try {
      return JSON.parse(plain) as T
    } catch {
      return undefined
    }
  }

  clientInformation = (id: string) => this.read<OAuthClientInformationMixed>(this.data[id]?.client)
  tokens = (id: string) => this.read<OAuthTokens>(this.data[id]?.tokens)
  discovery = (id: string) => this.data[id]?.discovery as OAuthDiscoveryState | undefined
  hasTokens = (id: string) => !!this.data[id]?.tokens

  saveClientInformation(id: string, info: OAuthClientInformationMixed) {
    ;(this.data[id] ??= {}).client = this.crypto.encrypt(JSON.stringify(info))
    return this.persist()
  }
  saveTokens(id: string, t: OAuthTokens) {
    ;(this.data[id] ??= {}).tokens = this.crypto.encrypt(JSON.stringify(t))
    return this.persist()
  }
  saveDiscovery(id: string, d: OAuthDiscoveryState) {
    ;(this.data[id] ??= {}).discovery = d
    return this.persist()
  }

  async clear(id: string, scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all') {
    const e = this.data[id]
    if (!e) return
    if (scope === 'all') delete this.data[id]
    else if (scope === 'client') delete e.client
    else if (scope === 'tokens') delete e.tokens
    else delete e.discovery
    await this.persist()
  }
}

// ---------------------------------------------------------------- loopback callback server

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em;color:#222}h1{font-size:1.3em}</style><h1>${title}</h1><p>${body}</p>`

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

interface Flow {
  resolve(code: string): void
  reject(e: Error): void
  timer: NodeJS.Timeout
}

/**
 * Receives the browser's redirect (`http://127.0.0.1:<port>/callback?code=…&state=…`). Bound to loopback only, accepts
 * one matching `state` once, and is only running while a sign-in is in progress.
 */
export class CallbackServer {
  private server?: http.Server
  private port = 0
  /** Port of the most recent listener, so redirectUrl stays truthful after it closes. */
  private lastPort = 0
  private refs = 0
  private starting?: Promise<void>
  private flows = new Map<string, Flow>()

  constructor(private opts: { preferredPort?: number; timeoutMs?: number } = {}) {}

  get redirectUrl(): string {
    const port = this.port || this.lastPort || (this.opts.preferredPort ?? OAUTH_REDIRECT_PORT)
    return `http://127.0.0.1:${port}/callback`
  }

  /** Start listening (shared by concurrent sign-ins); pair every acquire() with a release(). */
  async acquire(): Promise<void> {
    this.refs++
    try {
      await (this.starting ??= this.start())
    } catch (e) {
      this.refs--
      this.starting = undefined
      throw e
    }
  }

  release(): void {
    if (--this.refs > 0) return
    this.refs = 0
    for (const [state, f] of this.flows) {
      clearTimeout(f.timer)
      f.reject(new Error('Sign-in was cancelled.'))
      this.flows.delete(state)
    }
    const s = this.server
    this.server = undefined
    this.starting = undefined
    this.port = 0
    if (s) {
      s.closeAllConnections?.()
      s.close()
    }
  }

  private async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res))
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    try {
      await listen(this.opts.preferredPort ?? OAUTH_REDIRECT_PORT)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      await listen(0) // fixed port is taken: use any free one (a new client registration follows automatically)
    }
    this.port = this.lastPort = (server.address() as { port: number }).port
    this.server = server
  }

  /** Wait for the redirect carrying `state`. Rejects on provider error, timeout, or cancel(). */
  expect(state: string): { promise: Promise<string>; cancel(reason?: string): void } {
    let flow!: Flow
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flows.delete(state)
        reject(new Error('Timed out waiting for you to finish signing in.'))
      }, this.opts.timeoutMs ?? 5 * 60_000)
      flow = { resolve, reject, timer }
      this.flows.set(state, flow)
    })
    promise.catch(() => {}) // callers await it; avoid unhandled-rejection noise if cancelled first
    return {
      promise,
      cancel: (reason = 'Sign-in was cancelled.') => {
        if (this.flows.get(state) === flow) {
          clearTimeout(flow.timer)
          this.flows.delete(state)
          flow.reject(new Error(reason))
        }
      }
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, html: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
      })
      res.end(html)
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return send(400, page('Bad request', 'Malformed URL.'))
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') return send(404, page('Not found', 'Nothing here.'))

    const state = url.searchParams.get('state') ?? ''
    const flow = this.flows.get(state)
    if (!state || !flow) return send(400, page('Sign-in not recognised', 'This sign-in link is unknown or has already been used. Return to Talaria and try again.'))
    this.flows.delete(state) // single use
    clearTimeout(flow.timer)

    const err = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (err) {
      flow.reject(new Error(`The server denied the sign-in (${err})${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}.`))
      return send(200, page('Sign-in cancelled', `The server reported: ${esc(err)}. You can close this tab and return to Talaria.`))
    }
    if (!code) {
      flow.reject(new Error('The sign-in response had no authorization code.'))
      return send(400, page('Sign-in failed', 'No authorization code was returned.'))
    }
    flow.resolve(code)
    send(200, page('Signed in', 'You can close this tab and return to Talaria.'))
  }
}

// ---------------------------------------------------------------- SDK provider

/** https, or http on a loopback host (for local development servers). */
export function isSafeAuthUrl(u: URL): boolean {
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)
}

export interface ProviderOptions {
  serverId: string
  store: OAuthStore
  callback: CallbackServer
  /** false = never start a sign-in or register a client: only use/refresh stored tokens. */
  interactive: boolean
  openBrowser(url: string): Promise<void>
  /** Pre-registered OAuth app, for servers without dynamic client registration. */
  manual?: { clientId?: string; clientSecret?: string; scope?: string }
}

export class TalariaOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  private pending?: { promise: Promise<string>; cancel(r?: string): void }
  private verifier?: string
  private stateValue?: string

  constructor(private o: ProviderOptions) {}

  get redirectUrl(): string {
    return this.o.callback.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Talaria',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.o.manual?.clientSecret ? 'client_secret_post' : 'none',
      ...(this.o.manual?.scope ? { scope: this.o.manual.scope } : {})
    }
  }

  state(): string {
    return (this.stateValue = randomBytes(24).toString('base64url'))
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const m = this.o.manual
    if (m?.clientId) return { client_id: m.clientId, ...(m.clientSecret ? { client_secret: m.clientSecret } : {}) }
    const stored = this.o.store.clientInformation(this.o.serverId)
    // Refreshing a token doesn't involve the redirect URI, so background use takes the registration as it is.
    if (!this.o.interactive) return stored
    // Starting a NEW sign-in: a registration made for another loopback port can't be used for this redirect URI.
    const uris = (stored as { redirect_uris?: string[] } | undefined)?.redirect_uris
    return stored && uris && !uris.includes(this.redirectUrl) ? undefined : stored
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // Registering a new OAuth client is a user-initiated act, never a background one.
    if (!this.o.interactive) throw new NeedsInteractiveAuth()
    await this.o.store.saveClientInformation(this.o.serverId, info)
  }

  tokens = () => this.o.store.tokens(this.o.serverId)
  saveTokens = (t: OAuthTokens) => this.o.store.saveTokens(this.o.serverId, t)
  discoveryState = () => this.o.store.discovery(this.o.serverId)
  saveDiscoveryState = (d: OAuthDiscoveryState) => this.o.store.saveDiscovery(this.o.serverId, d)

  saveCodeVerifier(v: string) {
    this.verifier = v // memory only: never written to disk
  }
  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in is in progress (missing PKCE verifier).')
    return this.verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') this.verifier = undefined
    else await this.o.store.clear(this.o.serverId, scope === 'all' ? 'all' : scope)
  }

  /** Called by the SDK when it needs the user. In background mode we only note that sign-in is required. */
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!isSafeAuthUrl(url)) throw new Error(`Refusing to open an unsafe sign-in URL (${url.protocol}//${url.host}). Authorization pages must use https.`)
    this.authorizationUrl = url
    if (!this.o.interactive) throw new NeedsInteractiveAuth()
    if (!this.stateValue) throw new Error('Internal error: sign-in started without a state value.')
    this.pending?.cancel('A newer sign-in replaced this one.')
    this.pending = this.o.callback.expect(this.stateValue)
    await this.o.openBrowser(url.toString())
  }

  /** Resolves with the authorization code once the browser comes back (or rejects: denied / timed out / cancelled). */
  waitForCode(): Promise<string> {
    if (!this.pending) return Promise.reject(new Error('No sign-in is waiting.'))
    return this.pending.promise
  }

  cancel(reason?: string) {
    this.pending?.cancel(reason)
  }

  /** Sign-in finished: from here on only silent token refresh is allowed. */
  settle() {
    this.o.interactive = false
    this.pending = undefined
  }

  reopen(): Promise<void> {
    return this.authorizationUrl ? this.o.openBrowser(this.authorizationUrl.toString()) : Promise.resolve()
  }
}
