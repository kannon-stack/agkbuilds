const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const BIN = process.env.TALARIA_BIN
const openaiBodies = []

// fake OpenAI-compatible model on the default port: calls cloud__whoami when asked
const model = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => {
    if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"m"}]}') }
    const b = JSON.parse(raw); openaiBodies.push(b); const last = b.messages.at(-1)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (d) => res.write('data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n')
    if (last.role === 'user' && last.content === 'WHO') { send({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'cloud__whoami', arguments: '{}' } }] }) }
    else if (last.role === 'tool') send({ content: 'Tool said: ' + last.content })
    else send({ content: 'ok' })
    res.end('data: [DONE]\n\n')
  })
})

const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms))
;(async () => {
  const { startOAuthMcpServer } = await import(path.join(APP, 'tests/fixtures/oauth-mcp-server.mjs'))
  const srv = await startOAuthMcpServer({ preRegistered: [{ client_id: 'my-app', client_secret: 'SUPER-SECRET-VALUE' }] })
  await new Promise(r => model.listen(20128, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria9-')); const ud = path.join(root, 'ud'); fs.mkdirSync(ud)
  const rec = { id: 'r1', name: 'Cloud', enabled: true, transport: 'http', url: srv.mcpUrl, env: {}, headers: {}, policy: 'ask', toolPolicies: {} }
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, theme: 'dark', providers: [{ id: 'default', kind: 'openai', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'm' }], activeProviderId: 'default', tools: { enabled: true, workspace: '', policies: {} }, mcpServers: [rec] }))
  const launch = async () => {
    const app = await electron.launch({ executablePath: BIN || ELECTRON, args: [...(BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u) } }) // capture instead of launching a real browser
    const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 900 }); await win.waitForSelector('.sidebar')
    win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 }); win.on('dialog', d => d.accept())
    return { app, win }
  }
  const opened = (app) => app.evaluate(() => globalThis.__opened)
  const card = (win) => win.locator('.mcp-server').first()
  const openMcp = async (win) => { await win.keyboard.press('Control+,'); await win.click('.tabs button:has-text("MCP")'); await win.waitForSelector('.mcp-server') }

  let { app, win } = await launch()
  await openMcp(win); await settle(1500)

  // ---- 1. needs sign-in, quietly
  check((await card(win).textContent()).includes('Sign-in required') && await win.$('.mcp-server .signin') !== null, 'unauthenticated remote server shows "Sign-in required" + Sign in button')
  check((await opened(app)).length === 0 && srv.stats.registrations.length === 0, 'startup did NOT open a browser or register a client by itself')
  await win.screenshot({ path: path.join(SHOTS, '37-oauth-needs-signin.png') })

  // ---- 2. sign in → authorizing → cancel → retry
  await win.click('.mcp-server .signin'); await win.waitForSelector('.mcp-server:has-text("Waiting for sign-in")')
  let urls = await opened(app); check(urls.length === 1, 'clicking Sign in opens the system browser once')
  const u = new URL(urls[0])
  check(u.origin === srv.url && u.searchParams.get('redirect_uri') === 'http://127.0.0.1:33418/callback' && u.searchParams.get('code_challenge_method') === 'S256', 'authorization URL: right server, PKCE S256, loopback redirect on the fixed port')
  check((await card(win).textContent()).includes('127.0.0.1:' + new URL(srv.url).port), 'UI names the host you are being asked to approve')
  await win.screenshot({ path: path.join(SHOTS, '38-oauth-authorizing.png') })
  await win.click('button:has-text("Open sign-in page again")'); await settle(200)
  check((await opened(app)).length === 2, '"Open sign-in page again" re-opens it')
  await win.click('.mcp-server button:has-text("Cancel")'); await win.waitForSelector('.mcp-server:has-text("Sign-in required")')
  check((await card(win).textContent()).toLowerCase().includes('cancelled'), 'Cancel returns to "Sign-in required" and says it was cancelled')
  const cb = await fetch('http://127.0.0.1:33418/callback?code=x&state=y').then(() => 'open', () => 'closed')
  check(cb === 'closed', 'the loopback listener is closed when no sign-in is pending')

  await win.click('.mcp-server .signin'); await win.waitForSelector('.mcp-server:has-text("Waiting for sign-in")')
  urls = await opened(app)
  const forged = await fetch('http://127.0.0.1:33418/callback?code=evil&state=forged'); check(forged.status === 400, 'forged callback (unknown state) is rejected')
  const done = await srv.approve(urls.at(-1)); check(done.status === 200 && (await done.text()).includes('Signed in'), 'approving in the "browser" lands on the app\'s Signed-in page')
  await win.waitForSelector('.mcp-server:has-text("Connected")', { timeout: 15000 })
  check((await card(win).textContent()).includes('signed in') && (await card(win).textContent()).includes('2 tools') && await win.$('.mcp-server button:has-text("Sign out")') !== null, 'connected: "signed in", 2 tools, Sign out available')
  await win.screenshot({ path: path.join(SHOTS, '39-oauth-connected.png') })

  // ---- 3. tokens stay out of the UI process; file is private
  const exposed = await win.evaluate(async () => JSON.stringify([await window.api.settings.get(), await window.api.mcp.status()]))
  check(!/at_|rt_|Bearer|access_token|refresh_token/.test(exposed) && exposed.includes('"signedIn":true'), 'tokens never reach the renderer (only signedIn: true)')
  const oauthFile = path.join(ud, 'mcp-oauth.json')
  check((fs.statSync(oauthFile).mode & 0o777) === 0o600, 'mcp-oauth.json is owner-only (0600)')
  check(!fs.readFileSync(path.join(ud, 'settings.json'), 'utf8').match(/at_|rt_/), 'tokens are not in settings.json')
  await win.keyboard.press('Escape')

  // ---- 4. use it from chat: Bearer token reaches the server
  await win.fill('.composer textarea', 'WHO'); await win.keyboard.press('Enter'); await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-name')).includes('Cloud'), 'chat tool card is labelled with the server: ' + (await win.textContent('.tool-name')))
  await win.click('button:has-text("Allow once")'); await win.waitForFunction(() => !document.querySelector('.send.stop'))
  check(openaiBodies.at(-1).messages.at(-1).content.startsWith('token ends '), 'tool ran over OAuth: "' + openaiBodies.at(-1).messages.at(-1).content + '"')

  // ---- 5. restart: silent reconnect, no browser
  await app.close(); ;({ app, win } = await launch()); await openMcp(win)
  await win.waitForSelector('.mcp-server:has-text("Connected")', { timeout: 15000 })
  check((await opened(app)).length === 0 && srv.stats.registrations.length === 1, 'after restart: reconnected silently — no browser, no new registration')

  // ---- 6. access token expires: silent refresh
  srv.expireAccessTokens()
  await win.keyboard.press('Escape'); await win.keyboard.press('Control+n'); await win.fill('.composer textarea', 'WHO'); await win.keyboard.press('Enter'); await win.waitForSelector('.tool-awaiting_approval')
  await win.click('button:has-text("Allow once")'); await win.waitForFunction(() => !document.querySelector('.send.stop'))
  check(openaiBodies.at(-1).messages.at(-1).content.startsWith('token ends ') && srv.stats.token.some(t => t.grant_type === 'refresh_token') && (await opened(app)).length === 0, 'expired token → refreshed in the background, tool still worked, no browser')

  // ---- 7. advanced OAuth settings: secret is write-only
  await openMcp(win); await win.click('.mcp-server button:has-text("Edit")'); await win.waitForSelector('.oauth-adv')
  await win.click('.oauth-adv summary')
  check((await win.textContent('.oauth-adv')).includes('http://127.0.0.1:33418/callback'), 'form shows the redirect URI to register with a pre-registered app')
  await win.fill('.oauth-adv label:has-text("Client ID") input', 'my-app'); await win.fill('.oauth-adv input[type=password]', 'SUPER-SECRET-VALUE'); await win.fill('.oauth-adv label:has-text("Scope") input', 'mcp:read')
  await win.click('button:has-text("Save")'); await settle(600)
  const pub = await win.evaluate(async () => JSON.stringify((await window.api.settings.get()).mcpServers[0].oauth))
  check(pub.includes('"clientId":"my-app"') && pub.includes('"hasClientSecret":true') && !pub.includes('SUPER-SECRET'), 'client id/scope saved; secret is write-only (hasClientSecret only)')
  await win.waitForSelector('.mcp-server:has-text("Connected")', { timeout: 15000 }) // editing reconnects with stored tokens

  // ---- 8. sign out
  await win.click('.mcp-server button:has-text("Sign out")'); await win.waitForSelector('.mcp-server:has-text("Sign-in required")', { timeout: 15000 })
  const afterOut = JSON.parse(fs.readFileSync(oauthFile, 'utf8')).servers
  check(!afterOut.r1?.tokens, 'Sign out deletes the stored tokens from disk')
  check(!(await card(win).textContent()).includes('signed in'), 'UI no longer says signed in')

  // ---- 9. removing the server deletes its credentials
  await win.click('.mcp-server .signin'); await win.waitForSelector('.mcp-server:has-text("Waiting for sign-in")'); await srv.approve((await opened(app)).at(-1)); await win.waitForSelector('.mcp-server:has-text("Connected")', { timeout: 15000 })
  check(!!JSON.parse(fs.readFileSync(oauthFile, 'utf8')).servers.r1?.tokens, 'signed in again with the pre-registered settings saved')
  const lastAuth = srv.stats.authorize.at(-1), lastTok = srv.stats.token.at(-1)
  check(lastAuth.client_id === 'my-app' && lastAuth.scope === 'mcp:read' && lastTok.client_id === 'my-app' && lastTok.has_secret === true && srv.stats.registrations.length === 1, 'manual app used: client id + scope in the authorize request, the write-only secret reached the token endpoint, no new registration')
  await win.click('.mcp-server button:has-text("Remove")'); await settle(800)
  check(!JSON.parse(fs.readFileSync(oauthFile, 'utf8')).servers.r1, 'removing the server also deletes its OAuth credentials')

  await app.close(); await srv.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
