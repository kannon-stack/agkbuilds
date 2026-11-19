// A fake OAuth 2.1-protected MCP server for tests: RFC 9728 discovery, RFC 8414 metadata, RFC 7591 registration,
// authorization-code + PKCE(S256), single-use codes, rotating refresh tokens, expiry — and an MCP endpoint behind Bearer auth.
import http from 'node:http'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const b64url = (b) => Buffer.from(b).toString('base64url')
const rand = (n = 18) => crypto.randomBytes(n).toString('base64url')

export async function startOAuthMcpServer(opts = {}) {
  const { supportRegistration = true, preRegistered = [], denyAuthorize = false, authorizationEndpointOverride } = opts
  const accessTtlMs = opts.accessTtlMs ?? 3_600_000
  const stats = { registrations: [], authorize: [], token: [], mcp: 0, mcpUnauthorized: 0 }
  const clients = new Map(preRegistered.map((c) => [c.client_id, { ...c }]))
  const codes = new Map()
  const access = new Map() // token -> expiresAt
  const refresh = new Map() // token -> client_id
  let base = ''

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(obj))
  }

  const issue = (client_id) => {
    const at = 'at_' + rand(), rt = 'rt_' + rand()
    access.set(at, Date.now() + accessTtlMs)
    refresh.set(rt, client_id)
    return { access_token: at, token_type: 'Bearer', expires_in: Math.round(accessTtlMs / 1000), refresh_token: rt }
  }

  const mcpServer = () => {
    const s = new McpServer({ name: 'oauth-fixture', version: '1.0.0' })
    s.registerTool('whoami', { description: 'Returns the tail of the bearer token used', inputSchema: {} }, async (_a, extra) => ({
      content: [{ type: 'text', text: `token ends ${String(extra.requestInfo?.headers?.authorization ?? '').slice(-4)}` }]
    }))
    s.registerTool('echo', { description: 'Echo', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }))
    return s
  }

  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const url = new URL(req.url, base || 'http://127.0.0.1')
    const p = url.pathname

    if (p.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] })
    }
    if (p.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: authorizationEndpointOverride ?? `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(supportRegistration ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
      })
    }
    if (p === '/register' && req.method === 'POST' && supportRegistration) {
      const meta = JSON.parse(raw)
      const client_id = 'client-' + rand(6)
      const method = meta.token_endpoint_auth_method ?? 'none'
      const client = { client_id, redirect_uris: meta.redirect_uris, token_endpoint_auth_method: method, ...(method === 'client_secret_post' ? { client_secret: rand() } : {}) }
      clients.set(client_id, client)
      stats.registrations.push(meta)
      return json(res, 201, { ...client, client_name: meta.client_name, client_id_issued_at: Math.floor(Date.now() / 1000), grant_types: meta.grant_types, response_types: meta.response_types })
    }
    if (p === '/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams)
      stats.authorize.push(q)
      const client = clients.get(q.client_id)
      if (!client) return json(res, 400, { error: 'invalid_client' })
      const okRedirect = client.redirect_uris ? client.redirect_uris.includes(q.redirect_uri) : /^http:\/\/127\.0\.0\.1:\d+\//.test(q.redirect_uri ?? '')
      if (!okRedirect) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri mismatch' })
      if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) return json(res, 400, { error: 'invalid_request' })
      const back = new URL(q.redirect_uri)
      if (q.state) back.searchParams.set('state', q.state)
      if (denyAuthorize) back.searchParams.set('error', 'access_denied')
      else {
        const code = 'code_' + rand()
        codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (p === '/token' && req.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(raw))
      stats.token.push({ grant_type: f.grant_type, client_id: f.client_id, has_secret: !!f.client_secret, resource: f.resource })
      const client = clients.get(f.client_id)
      if (!client) return json(res, 401, { error: 'invalid_client' })
      if (client.client_secret && f.client_secret !== client.client_secret) return json(res, 401, { error: 'invalid_client', error_description: 'bad secret' })
      if (f.grant_type === 'authorization_code') {
        const c = codes.get(f.code)
        codes.delete(f.code) // single use
        if (!c || c.client_id !== f.client_id || c.redirect_uri !== f.redirect_uri) return json(res, 400, { error: 'invalid_grant' })
        if (b64url(crypto.createHash('sha256').update(f.code_verifier ?? '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        return json(res, 200, issue(f.client_id))
      }
      if (f.grant_type === 'refresh_token') {
        if (refresh.get(f.refresh_token) !== f.client_id) return json(res, 400, { error: 'invalid_grant' })
        refresh.delete(f.refresh_token) // rotate
        return json(res, 200, issue(f.client_id))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (p === '/mcp') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const exp = token && access.get(token)
      if (!exp || exp < Date.now()) {
        stats.mcpUnauthorized++
        return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
      }
      stats.mcp++
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      const s = mcpServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { transport.close(); s.close() })
      await s.connect(transport)
      return transport.handleRequest(req, res, JSON.parse(raw))
    }
    json(res, 404, { error: 'not_found' })
  })

  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`

  return {
    url: base,
    mcpUrl: `${base}/mcp`,
    stats,
    expireAccessTokens: () => { for (const k of access.keys()) access.set(k, 0) },
    revokeRefreshTokens: () => refresh.clear(),
    /** What the user's browser would do: open the authorization URL, then follow the redirect back to the app. */
    async approve(authorizeUrl) {
      const r = await fetch(authorizeUrl, { redirect: 'manual' })
      const loc = r.headers.get('location')
      if (!loc) throw new Error(`authorize did not redirect (${r.status}): ${await r.text()}`)
      return fetch(loc)
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  }
}
