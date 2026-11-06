import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { McpManager } from '../src/main/mcp/manager'
import { CallbackServer, NeedsInteractiveAuth, OAuthStore, TalariaOAuthProvider, isSafeAuthUrl, type SecretCrypto } from '../src/main/mcp/oauth'
import type { McpServerRecord, Secret } from '../src/main/store'
import { startOAuthMcpServer } from './fixtures/oauth-mcp-server.mjs'

type Fixture = Awaited<ReturnType<typeof startOAuthMcpServer>>

const plain: SecretCrypto = { encrypt: (p) => ({ encrypted: false, value: p }), decrypt: (s) => s?.value }
/** Obfuscating crypto so a test can prove tokens are not written in the clear. */
const scrambled: SecretCrypto = { encrypt: (p) => ({ encrypted: true, value: Buffer.from(p).reverse().toString('base64') }), decrypt: (s) => (s ? Buffer.from(s.value, 'base64').reverse().toString() : undefined) }

let dir = ''
const cleanups: (() => Promise<void> | void)[] = []
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'oauth-')) })
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const rec = (url: string, over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 'srv', name: 'Remote', enabled: true, transport: 'http', url, env: {}, headers: {}, policy: 'ask', toolPolicies: {}, ...over
})

async function setup(srv: Fixture, crypto: SecretCrypto = plain, file = path.join(dir, 'mcp-oauth.json')) {
  const store = new OAuthStore(file, crypto)
  await store.init()
  const callback = new CallbackServer({ preferredPort: 0, timeoutMs: 8000 })
  const opened: string[] = []
  let onOpen: ((u: string) => void) | undefined
  const mgr = new McpManager({ decrypt: (s?: Secret) => s?.value })
  mgr.initOAuth({ store, callback, openBrowser: async (u) => { opened.push(u); onOpen?.(u) } })
  cleanups.push(() => mgr.closeAll())
  return { store, callback, mgr, opened, autoApprove: () => { onOpen = (u) => void srv.approve(u) } }
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const stateOf = (m: McpManager) => m.status()[0].state
const call = (m: McpManager, tool: string, args: object = {}) => m.tools().find((t) => t.name.endsWith(`__${tool}`))!.run(args, { workspace: '', signal: new AbortController().signal })

let srv: Fixture
const serve = async (o: Parameters<typeof startOAuthMcpServer>[0] = {}) => { srv = await startOAuthMcpServer(o); cleanups.push(() => srv.close()); return srv }

describe('provider guards', () => {
  const mk = (interactive: boolean, opened: string[] = []) => {
    const store = new OAuthStore(path.join(dir, 'x.json'), plain)
    const callback = new CallbackServer({ preferredPort: 0 })
    return { p: new TalariaOAuthProvider({ serverId: 's', store, callback, interactive, openBrowser: async (u) => void opened.push(u) }), callback, store }
  }
  it('only opens https (or loopback http) authorization pages', async () => {
    expect(isSafeAuthUrl(new URL('https://auth.example.com/a'))).toBe(true)
    expect(isSafeAuthUrl(new URL('http://127.0.0.1:9/a'))).toBe(true)
    expect(isSafeAuthUrl(new URL('http://localhost/a'))).toBe(true)
    for (const bad of ['http://auth.example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', 'data:text/html,hi']) expect(isSafeAuthUrl(new URL(bad)), bad).toBe(false)
    const opened: string[] = []
    const { p, callback } = mk(true, opened)
    await callback.acquire(); cleanups.push(() => callback.release())
    p.state()
    await expect(p.redirectToAuthorization(new URL('file:///etc/passwd'))).rejects.toThrow(/Refusing to open/)
    await expect(p.redirectToAuthorization(new URL('http://evil.example.com/authorize'))).rejects.toThrow(/Refusing to open/)
    expect(opened).toEqual([])
    await p.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'))
    expect(opened).toEqual(['https://auth.example.com/authorize?x=1'])
  })
  it('background (non-interactive) mode never opens a browser and never registers a client', async () => {
    const opened: string[] = []
    const { p } = mk(false, opened)
    p.state()
    await expect(p.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toBeInstanceOf(NeedsInteractiveAuth)
    await expect(p.saveClientInformation({ client_id: 'x' })).rejects.toBeInstanceOf(NeedsInteractiveAuth)
    expect(opened).toEqual([])
  })
  it('keeps the PKCE verifier in memory only, and ignores a registration made for another redirect port', async () => {
    const { p, store, callback } = mk(true)
    expect(() => p.codeVerifier()).toThrow(/No sign-in/)
    p.saveCodeVerifier('verifier123')
    expect(p.codeVerifier()).toBe('verifier123')
    expect(readdirSync(dir)).toEqual([])
    await callback.acquire(); cleanups.push(() => callback.release())
    await store.saveClientInformation('s', { client_id: 'old', redirect_uris: ['http://127.0.0.1:1/callback'] } as any)
    expect(p.clientInformation()).toBeUndefined() // a NEW sign-in would register again for the current redirect URI
    const background = new TalariaOAuthProvider({ serverId: 's', store, callback, interactive: false, openBrowser: async () => {} })
    expect(background.clientInformation()?.client_id).toBe('old') // …but refreshing a token must still work with it
    await store.saveClientInformation('s', { client_id: 'new', redirect_uris: [callback.redirectUrl] } as any)
    expect(p.clientInformation()?.client_id).toBe('new')
  })
})

describe('OAuthStore', () => {
  it('stores per-server credentials encrypted, owner-only, and reloads them', async () => {
    const file = path.join(dir, 'o.json')
    const s = new OAuthStore(file, scrambled); await s.init()
    await s.saveTokens('a', { access_token: 'SECRET-ACCESS-TOKEN', token_type: 'Bearer', refresh_token: 'SECRET-REFRESH' })
    await s.saveClientInformation('a', { client_id: 'cid-a' })
    await s.saveTokens('b', { access_token: 'other', token_type: 'Bearer' })
    const disk = readFileSync(file, 'utf8')
    expect(disk).not.toContain('SECRET-ACCESS-TOKEN')
    expect(disk).not.toContain('SECRET-REFRESH')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const s2 = new OAuthStore(file, scrambled); await s2.init()
    expect(s2.tokens('a')?.access_token).toBe('SECRET-ACCESS-TOKEN')
    expect(s2.clientInformation('a')?.client_id).toBe('cid-a')
    expect(s2.tokens('b')?.access_token).toBe('other')
    expect(s2.hasTokens('a')).toBe(true)
  })
  it('clears by scope and per server; survives a corrupt file by moving it aside', async () => {
    const file = path.join(dir, 'o.json')
    const s = new OAuthStore(file, plain); await s.init()
    await s.saveTokens('a', { access_token: 't', token_type: 'Bearer' }); await s.saveClientInformation('a', { client_id: 'c' }); await s.saveTokens('b', { access_token: 't2', token_type: 'Bearer' })
    await s.clear('a', 'tokens')
    expect(s.hasTokens('a')).toBe(false); expect(s.clientInformation('a')?.client_id).toBe('c')
    await s.clear('a', 'all')
    expect(s.clientInformation('a')).toBeUndefined(); expect(s.hasTokens('b')).toBe(true)
    writeFileSync(file, '{ nope')
    const s3 = new OAuthStore(file, plain); await s3.init()
    expect(s3.hasTokens('b')).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('o.json.corrupt-'))).toBe(true)
  })
})

describe('CallbackServer', () => {
  const get = (url: string, method = 'GET') => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const u = new URL(url)
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers })) })
    r.on('error', reject); r.end()
  })
  const mk = async (opts = {}) => { const c = new CallbackServer({ preferredPort: 0, timeoutMs: 3000, ...opts }); await c.acquire(); cleanups.push(() => c.release()); return c }

  it('delivers the code for a matching state, once; unknown/replayed states are rejected', async () => {
    const c = await mk()
    const f = c.expect('state-1')
    expect((await get(`${c.redirectUrl}?code=bad&state=wrong`)).status).toBe(400)
    expect((await get(`${c.redirectUrl}?code=abc`)).status).toBe(400)
    const ok = await get(`${c.redirectUrl}?code=THE-CODE&state=state-1`)
    expect(ok.status).toBe(200); expect(ok.body).toContain('Signed in')
    expect(await f.promise).toBe('THE-CODE')
    expect((await get(`${c.redirectUrl}?code=again&state=state-1`)).status).toBe(400) // single use
  })
  it('reports provider errors, escapes their text, and sets restrictive headers', async () => {
    const c = await mk()
    const f = c.expect('s2')
    const res = await get(`${c.redirectUrl}?error=${encodeURIComponent('<script>alert(1)</script>')}&state=s2`)
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).toContain('&lt;script&gt;')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['cache-control']).toBe('no-store')
    await expect(f.promise).rejects.toThrow(/denied/)
  })
  it('only serves GET /callback, only on loopback', async () => {
    const c = await mk()
    const base = c.redirectUrl.replace('/callback', '')
    expect((await get(`${base}/other`)).status).toBe(404)
    expect((await get(`${c.redirectUrl}?state=x&code=y`, 'POST')).status).toBe(404)
    expect(new URL(c.redirectUrl).hostname).toBe('127.0.0.1')
  })
  it('times out, can be cancelled, and release() cancels pending flows and closes the port', async () => {
    const c = await mk({ timeoutMs: 150 })
    await expect(c.expect('t').promise).rejects.toThrow(/Timed out/)
    const f = c.expect('cancel-me'); f.cancel(); await expect(f.promise).rejects.toThrow(/cancelled/)
    const c2 = new CallbackServer({ preferredPort: 0 }); await c2.acquire(); await c2.acquire() // refcounted
    const pending = c2.expect('p'); const url = c2.redirectUrl
    c2.release(); expect((await get(`${url}?code=1&state=unknown`)).status).toBe(400) // still up for the second holder (answers, rejects unknown state)
    c2.release()
    await expect(pending.promise).rejects.toThrow(/cancelled/)
    await expect(get(`${url}?code=1&state=p`)).rejects.toThrow() // closed
  })
  it('falls back to a free port when the preferred one is busy', async () => {
    const blocker = http.createServer(); await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())))
    const busy = (blocker.address() as { port: number }).port
    const c = new CallbackServer({ preferredPort: busy }); await c.acquire(); cleanups.push(() => c.release())
    expect(new URL(c.redirectUrl).port).not.toBe(String(busy))
    const f = c.expect('s'); expect((await get(`${c.redirectUrl}?code=x&state=s`)).status).toBe(200); expect(await f.promise).toBe('x')
  })
})

describe('end to end against an OAuth-protected MCP server', () => {
  it('without tokens: connects in the background to "needs sign-in" — no browser, no registration', async () => {
    const s = await serve(); const { mgr, opened } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('needs_auth')
    expect(mgr.status()[0].error).toMatch(/sign in/i)
    expect(mgr.status()[0].signedIn).toBe(false)
    expect(opened).toEqual([]); expect(s.stats.registrations).toEqual([]); expect(s.stats.mcp).toBe(0)
    expect(mgr.tools()).toEqual([])
  })

  it('Sign in: registers a public PKCE client, opens the browser once, completes via the loopback redirect, lists tools', async () => {
    const s = await serve(); const { mgr, opened, callback, store } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000)
    mgr.signIn('srv')
    await waitFor(() => opened.length === 1)
    expect(stateOf(mgr)).toBe('authorizing')
    const authUrl = new URL(opened[0])
    expect(authUrl.origin).toBe(s.url)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')!.length).toBeGreaterThan(30)
    expect(authUrl.searchParams.get('state')!.length).toBeGreaterThan(20)
    expect(authUrl.searchParams.get('redirect_uri')).toBe(callback.redirectUrl)
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('resource')).toBe(s.mcpUrl)
    expect(s.stats.registrations).toHaveLength(1)
    expect(s.stats.registrations[0]).toMatchObject({ client_name: 'Talaria', redirect_uris: [callback.redirectUrl], token_endpoint_auth_method: 'none' })

    const cb = await s.approve(opened[0]) // the user clicks "Allow"; the browser lands on our loopback page
    expect(cb.status).toBe(200); expect(await cb.text()).toContain('Signed in')
    await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('connected')
    expect(mgr.status()[0]).toMatchObject({ signedIn: true, serverInfo: 'oauth-fixture 1.0.0' })
    expect(mgr.tools().map((t) => t.name).sort()).toEqual(['remote__echo', 'remote__whoami'])
    expect(await call(mgr, 'echo', { message: 'hi' })).toBe('echo: hi')
    expect(s.stats.token.map((t) => t.grant_type)).toEqual(['authorization_code'])
    expect(store.hasTokens('srv')).toBe(true)
    // the loopback listener is closed again once signed in
    await expect(fetch(callback.redirectUrl)).rejects.toThrow()
  })

  it('tokens persist (encrypted): a fresh app run reconnects silently — no browser, no new registration', async () => {
    const s = await serve(); const file = path.join(dir, 'persist.json')
    const a = await setup(s, scrambled, file); a.autoApprove()
    a.mgr.sync([rec(s.mcpUrl)]); await a.mgr.settled(10000); a.mgr.signIn('srv'); await a.mgr.settled(10000)
    expect(stateOf(a.mgr)).toBe('connected')
    await a.mgr.closeAll()
    expect(readFileSync(file, 'utf8')).not.toContain('at_')
    const b = await setup(s, scrambled, file)
    b.mgr.sync([rec(s.mcpUrl)]); await b.mgr.settled(10000)
    expect(stateOf(b.mgr)).toBe('connected')
    expect(b.opened).toEqual([])
    expect(s.stats.registrations).toHaveLength(1)
    expect(await call(b.mgr, 'whoami')).toMatch(/^token ends/)
  })

  it('expired access token: refreshes silently with the refresh token (rotating), no browser', async () => {
    const s = await serve(); const x = await setup(s); x.autoApprove()
    x.mgr.sync([rec(s.mcpUrl)]); await x.mgr.settled(10000); x.mgr.signIn('srv'); await x.mgr.settled(10000)
    const before = await call(x.mgr, 'whoami')
    s.expireAccessTokens()
    const after = await call(x.mgr, 'whoami')
    expect(after).not.toBe(before) // a new access token is in use
    expect(s.stats.token.map((t) => t.grant_type)).toEqual(['authorization_code', 'refresh_token'])
    expect(x.opened).toHaveLength(1)
    expect(stateOf(x.mgr)).toBe('connected')
    s.expireAccessTokens(); await call(x.mgr, 'whoami') // and again with the rotated refresh token
    expect(s.stats.token.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2)
  })

  it('refresh token revoked: tells the user to sign in again — never opens a browser by itself', async () => {
    const s = await serve(); const x = await setup(s); x.autoApprove()
    x.mgr.sync([rec(s.mcpUrl)]); await x.mgr.settled(10000); x.mgr.signIn('srv'); await x.mgr.settled(10000)
    s.expireAccessTokens(); s.revokeRefreshTokens()
    await expect(call(x.mgr, 'whoami')).rejects.toThrow(/sign in again/i)
    expect(stateOf(x.mgr)).toBe('needs_auth')
    expect(x.opened).toHaveLength(1)
  })

  it('a forged callback (wrong state) is ignored; the real one still completes the sign-in', async () => {
    const s = await serve(); const { mgr, opened, callback } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await waitFor(() => opened.length === 1)
    const evil = await fetch(`${callback.redirectUrl}?code=attacker-code&state=forged`)
    expect(evil.status).toBe(400)
    expect(stateOf(mgr)).toBe('authorizing')
    await s.approve(opened[0]); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('connected')
  })

  it('Cancel stops waiting and closes the listener; the user can retry', async () => {
    const s = await serve(); const { mgr, opened, callback } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await waitFor(() => opened.length === 1)
    mgr.cancelAuth('srv'); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('needs_auth'); expect(mgr.status()[0].error).toMatch(/cancelled/i)
    await expect(fetch(callback.redirectUrl)).rejects.toThrow()
    mgr.signIn('srv'); await waitFor(() => opened.length === 2)
    await s.approve(opened[1]); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('connected')
  })

  it('"Open again" re-opens the same authorization page', async () => {
    const s = await serve(); const { mgr, opened } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await waitFor(() => opened.length === 1)
    await mgr.reopenAuth('srv')
    expect(opened).toHaveLength(2); expect(opened[1]).toBe(opened[0])
    mgr.cancelAuth('srv'); await mgr.settled(10000)
  })

  it('the user denying access ends in "needs sign-in" with the reason', async () => {
    const s = await serve({ denyAuthorize: true }); const { mgr, opened } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await waitFor(() => opened.length === 1)
    await s.approve(opened[0]); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('needs_auth'); expect(mgr.status()[0].error).toMatch(/denied/i)
  })

  it('Sign out forgets tokens + registration; signing in again registers anew', async () => {
    const s = await serve(); const x = await setup(s); x.autoApprove()
    x.mgr.sync([rec(s.mcpUrl)]); await x.mgr.settled(10000); x.mgr.signIn('srv'); await x.mgr.settled(10000)
    expect(stateOf(x.mgr)).toBe('connected')
    await x.mgr.signOut('srv'); await x.mgr.settled(10000)
    expect(stateOf(x.mgr)).toBe('needs_auth'); expect(x.store.hasTokens('srv')).toBe(false); expect(x.mgr.status()[0].signedIn).toBe(false)
    x.mgr.signIn('srv'); await x.mgr.settled(10000)
    expect(stateOf(x.mgr)).toBe('connected'); expect(s.stats.registrations).toHaveLength(2)
  })

  it('removing the server deletes its stored credentials', async () => {
    const s = await serve(); const x = await setup(s); x.autoApprove()
    x.mgr.sync([rec(s.mcpUrl)]); await x.mgr.settled(10000); x.mgr.signIn('srv'); await x.mgr.settled(10000)
    expect(x.store.hasTokens('srv')).toBe(true)
    x.mgr.sync([]); await new Promise((r) => setTimeout(r, 100))
    expect(x.store.hasTokens('srv')).toBe(false)
  })

  it('pre-registered app (no dynamic registration): uses the configured client id + secret and never registers', async () => {
    const s = await serve({ supportRegistration: false, preRegistered: [{ client_id: 'pre-1', client_secret: 's3cret' }] }); const x = await setup(s); x.autoApprove()
    const r = rec(s.mcpUrl, { oauth: { clientId: 'pre-1', clientSecret: { encrypted: false, value: 's3cret' }, scope: 'mcp.read' } })
    x.mgr.sync([r]); await x.mgr.settled(10000); x.mgr.signIn('srv'); await x.mgr.settled(10000)
    expect(stateOf(x.mgr)).toBe('connected')
    expect(s.stats.registrations).toEqual([])
    expect(s.stats.authorize[0]).toMatchObject({ client_id: 'pre-1', scope: 'mcp.read' })
    expect(s.stats.token[0]).toMatchObject({ client_id: 'pre-1', has_secret: true })
  })

  it('a server that cannot register clients and has no configured app: a clear, actionable error', async () => {
    const s = await serve({ supportRegistration: false }); const { mgr, opened } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await mgr.settled(10000)
    expect(stateOf(mgr)).toBe('error')
    expect(mgr.status()[0].error).toMatch(/Add a Client ID/)
    expect(opened).toEqual([])
  })

  it('refuses an unsafe authorization endpoint advertised by the server', async () => {
    const s = await serve({ authorizationEndpointOverride: 'http://evil.example.com/authorize' }); const { mgr, opened } = await setup(s)
    mgr.sync([rec(s.mcpUrl)]); await mgr.settled(10000); mgr.signIn('srv'); await mgr.settled(10000)
    expect(opened).toEqual([])
    expect(stateOf(mgr)).toBe('error'); expect(mgr.status()[0].error).toMatch(/unsafe sign-in URL/)
  })

  it('stdio servers are unaffected by OAuth', async () => {
    const s = await serve(); const { mgr } = await setup(s)
    mgr.sync([{ ...rec(''), transport: 'stdio', url: undefined, command: process.execPath, args: [path.resolve(__dirname, 'fixtures/mcp-server.mjs')] }]); await mgr.settled(15000)
    expect(stateOf(mgr)).toBe('connected'); expect(mgr.status()[0].signedIn).toBeUndefined()
  })
})
