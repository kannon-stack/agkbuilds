// Provider connections when Node's networking is blocked but the browser's isn't (antivirus/firewall/proxy
// setups on some Windows PCs): requests must fall back to Chromium's network stack (Electron net.fetch).
const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')

let hits = 0
const server = http.createServer((req, res) => {
  hits++
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"net-model"}]}') }
  if (req.url === '/v1/chat/completions') {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const parts = ['Hello ', 'through ', 'Chromium.']
      let i = 0
      const t = setInterval(() => {
        if (i >= parts.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
      }, 20)
    })
    return
  }
  res.writeHead(404); res.end()
})
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }

;(async () => {
  await new Promise((r) => server.listen(20128, '127.0.0.1', r))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria-net-'))
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, tools: { enabled: false } }))
  const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 800 }); await win.waitForSelector('.titlebar')
  win.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })

  // Block Node's fetch in the main process, the way security software blocking node networking would.
  await app.evaluate(() => {
    globalThis.__nodeFetchCalls = 0
    globalThis.fetch = async () => { globalThis.__nodeFetchCalls++; throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect EACCES 127.0.0.1:20128'), { code: 'EACCES' }) }) }
  })

  // Test connection on the default (localhost) provider.
  await win.keyboard.press('Control+,'); await win.waitForSelector('.provider-form')
  await win.fill('.provider-form input[placeholder*="20128"]', 'http://localhost:20128/v1')
  await win.click('button:has-text("Test connection")')
  await win.waitForSelector('.status')
  const status = await win.textContent('.status')
  check(/Connected — 1 model/.test(status), `Test connection works through the browser network (${status.trim()})`)
  check((await app.evaluate(() => globalThis.__nodeFetchCalls)) === 3, 'Node was tried first on localhost, 127.0.0.1 and [::1]')
  await win.screenshot({ path: path.join(SHOTS, 'network-1-fallback-connected.png') })
  await win.click('.settings-back')

  // Streaming chat goes through the same fallback (and straight to it now).
  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("net-model")')
  const before = await app.evaluate(() => globalThis.__nodeFetchCalls)
  await win.fill('.composer textarea', 'hi'); await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent === 'Hello through Chromium.', null, { timeout: 10000 })
  await win.waitForFunction(() => !document.querySelector('.send.stop'))
  check(true, 'streamed reply arrived through the browser network')
  check((await app.evaluate(() => globalThis.__nodeFetchCalls)) === before, 'once the fallback worked, later requests use it directly')

  // Server down: the error lists every attempt with its reason, including the browser network's.
  await new Promise((r) => server.close(r))
  await win.keyboard.press('Control+,'); await win.waitForSelector('.provider-form')
  await win.fill('.provider-form input[placeholder*="20128"]', 'http://127.0.0.1:20129/v1')
  await win.click('button:has-text("Test connection")')
  await win.waitForSelector('.status.bad')
  const bad = await win.textContent('.status.bad')
  check(/Could not reach http:\/\/127\.0\.0\.1:20129\/v1/.test(bad) && /127\.0\.0\.1:20129: .*EACCES/.test(bad) && /\(browser network\): .*ERR_CONNECTION_REFUSED/.test(bad), `error shows each attempt's reason (${bad.replace(/\s+/g, ' ').slice(0, 220)})`)
  check(/antivirus or firewall/.test(bad), 'blocked connections point at security software')
  await win.screenshot({ path: path.join(SHOTS, 'network-2-error-detail.png') })

  await app.close(); process.exit(process.exitCode || 0)
})().catch((e) => { console.error('CRASH', e); process.exit(1) })
