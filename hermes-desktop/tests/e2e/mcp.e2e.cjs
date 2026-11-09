const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { execSync } = require('child_process')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const FIXTURE = path.join(APP, 'tests/fixtures/mcp-server.mjs')
const bodies = []

const sse = (res, deltas) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let i = 0
  const t = setInterval(() => { if (i >= deltas.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + '\n\n') }, 5); res.on('close', () => clearInterval(t)) }
const toolCall = (res, name, args) => { const a = JSON.stringify(args)
  sse(res, [{ tool_calls: [{ index: 0, id: 'c' + Date.now(), function: { name, arguments: '' } }] }, ...a.match(/.{1,7}/gs).map(s => ({ tool_calls: [{ index: 0, function: { arguments: s } }] }))]) }
const text = (res, t) => sse(res, t.match(/.{1,6}/gs).map(content => ({ content })))
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"m"}]}') }
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => { const b = JSON.parse(raw); bodies.push(b); const last = b.messages.at(-1)
    if (last.role === 'user') {
      const q = last.content
      if (q === 'M1') return toolCall(res, 'fixture__echo', { message: 'hello mcp' })
      if (q === 'M2') return toolCall(res, 'fixture__add', { a: 2, b: 3 })
      if (q === 'M3') return toolCall(res, 'fixture__env', { name: 'MY_SECRET' })
      if (q === 'M4') return toolCall(res, 'fixture__fail', {})
      return text(res, 'plain')
    }
    return text(res, 'Result was: ' + String(last.content).slice(0, 60)) })
})
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
const sec = (v) => ({ encrypted: false, value: v })
const toolNames = (b) => (b.tools ?? []).map(t => t.function.name)

;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria4-')); const ud = path.join(root, 'ud'); fs.mkdirSync(ud)
  const base = { enabled: true, transport: 'stdio', headers: {}, policy: 'ask' }
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, theme: 'dark',
    providers: [{ id: 'default', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'm' }], activeProviderId: 'default',
    tools: { enabled: true, workspace: '', policies: {} },
    mcpServers: [
      { ...base, id: 'm1', name: 'Fixture', command: process.execPath, args: [FIXTURE], env: { MY_SECRET: sec('s3cr3t') }, toolPolicies: { add: 'allow' } },
      { ...base, id: 'm2', name: 'Broken', command: process.execPath, args: ['-e', 'console.error("missing TOKEN env var"); process.exit(1)'], env: {}, toolPolicies: {} }
    ] }))
  const launch = () => electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const app = await launch(); const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  const idle = () => win.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 20000 })
  const ask = async (q, fresh = true) => { if (fresh) await win.keyboard.press('Control+n'); await win.fill('.composer textarea', q); await win.keyboard.press('Enter') }
  const openMcp = async () => { await win.keyboard.press('Control+,'); await win.click('.tabs button:has-text("MCP")'); await win.waitForSelector('.mcp-server') }

  // M1 immediately after launch: servers may still be connecting; the app should wait briefly for them
  await ask('M1', false)
  await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-name')) === 'Fixture · echo', 'M1: card labelled "Fixture · echo"')
  check(await win.$('.tool-notice') !== null, 'M1: external-tool notice shown on approval')
  check(toolNames(bodies.at(-1)).includes('fixture__echo') && !toolNames(bodies.at(-1)).some(n => n.startsWith('broken__')), 'M1: model got fixture tools (first message right after launch); broken server contributes none')
  check(toolNames(bodies.at(-1)).every(n => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), 'M1: all tool names are valid function names')
  await win.screenshot({ path: path.join(SHOTS, '12-mcp-approval.png') })
  await win.click('button:has-text("Allow once")'); await idle()
  check(bodies.at(-1).messages.at(-1).content === 'echo: hello mcp', 'M1: MCP result reached the model')

  // M2: per-tool 'allow' => no prompt
  await ask('M2'); await idle()
  check(await win.$('.tool-awaiting_approval') === null && bodies.at(-1).messages.at(-1).content === '5', 'M2: per-tool "Always allow" ran without prompt (2+3=5)')

  // M3: env secret reached the child, but never the renderer
  await ask('M3'); await win.waitForSelector('.tool-awaiting_approval'); await win.click('button:has-text("Allow once")'); await idle()
  check(bodies.at(-1).messages.at(-1).content === 'MY_SECRET=s3cr3t', 'M3: stored env var passed to server process')
  const exposed = await win.evaluate(async () => JSON.stringify(await window.api.settings.get()))
  check(!exposed.includes('s3cr3t') && exposed.includes('"envKeys":["MY_SECRET"]'), 'M3: renderer sees env key names only, never values')

  // M4: isError => error card
  await ask('M4'); await win.waitForSelector('.tool-awaiting_approval'); await win.click('button:has-text("Allow once")'); await idle()
  check(await win.$('.tool-error') !== null && (await win.textContent('.tool-error .tool-pre >> nth=-1')).includes('something went wrong'), 'M4: server isError shown as failed card with message')

  // Settings UI
  await openMcp()
  const cards = await win.$$eval('.mcp-server', els => els.map(e => ({ name: e.querySelector('b').textContent, cls: e.className, txt: e.textContent })))
  check(cards[0].cls.includes('mcp-connected') && /Connected · \d+ tools · fixture 1\.2\.3/.test(cards[0].txt), 'UI: Fixture shows Connected with tool count + server info')
  check(cards[1].cls.includes('mcp-error') && cards[1].txt.includes('missing TOKEN'), 'UI: Broken shows error with the server\'s stderr')
  await win.screenshot({ path: path.join(SHOTS, '13-mcp-settings.png') })

  // per-tool policy via UI: disable echo -> disappears from the next request
  await win.click('.mcp-server >> nth=0 >> button:has-text("Show tools")')
  await win.selectOption('.mcp-tools tr:has(code:text-is("echo")) select', 'deny')
  await win.waitForTimeout(300)
  await win.screenshot({ path: path.join(SHOTS, '14-mcp-tools.png') })
  await win.keyboard.press('Escape'); await ask('hello'); await idle()
  check(!toolNames(bodies.at(-1)).includes('fixture__echo') && toolNames(bodies.at(-1)).includes('fixture__add'), 'UI: per-tool "Disabled" removes only that tool from the model request')

  // import via UI
  await openMcp(); await win.click('button:has-text("Import JSON")')
  await win.fill('.settings-page textarea', JSON.stringify({ mcpServers: { Imported: { command: process.execPath, args: [FIXTURE], env: { K: 'v' } }, Bad: { nothing: 1 } } }))
  await win.click('button:has-text("Review")'); await win.waitForSelector('.mcp-preview')
  check((await win.textContent('.settings-body')).includes('1 server will be added') && (await win.textContent('.settings-body')).includes('"Bad": needs a "command"'), 'UI: import preview lists valid server and per-entry error')
  await win.screenshot({ path: path.join(SHOTS, '15-mcp-import.png') })
  await win.click('button:has-text("Add & connect")')
  await win.waitForSelector('.mcp-server:has-text("Imported"):has-text("Connected")', { timeout: 15000 })
  check(true, 'UI: imported server added and connected')
  await win.keyboard.press('Escape'); await ask('hello2'); await idle()
  check(toolNames(bodies.at(-1)).includes('imported__echo') && toolNames(bodies.at(-1)).includes('fixture__add'), 'imported server tools available (imported__echo) alongside fixture')

  // toggle server off via UI
  await openMcp(); await win.click('.mcp-server:has-text("Fixture") >> label:has-text("On") input'); await win.waitForSelector('.mcp-server:has-text("Fixture"):has-text("Disabled")')
  await win.keyboard.press('Escape'); await ask('hello3'); await idle()
  check(!toolNames(bodies.at(-1)).some(n => n.startsWith('fixture__')) && toolNames(bodies.at(-1)).some(n => n.startsWith('imported__')), 'toggling a server off removes its tools immediately')

  // add via form (http transport validation)
  await openMcp(); await win.click('button:has-text("Add server")')
  await win.selectOption('.settings-page select >> nth=0', 'http'); await win.fill('input[placeholder="https://example.com/mcp"]', 'ftp://nope'); await win.click('button:has-text("Add server") >> nth=-1')
  check(await win.$('.status.bad:has-text("valid http")') !== null, 'UI: form rejects non-http URL')
  await win.screenshot({ path: path.join(SHOTS, '16-mcp-form.png') })

  // clean shutdown: no orphaned MCP server processes
  const before = execSync(`pgrep -fc "[m]cp-server.mjs" || true`).toString().trim()
  await app.evaluate(({ app }) => app.quit())
  await new Promise(r => setTimeout(r, 4000))
  const after = execSync(`pgrep -fc "[m]cp-server.mjs" || true`).toString().trim()
  check(Number(before) >= 1 && Number(after) === 0, `quit leaves no orphaned MCP processes (running before: ${before}, after: ${after})`)
  process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
