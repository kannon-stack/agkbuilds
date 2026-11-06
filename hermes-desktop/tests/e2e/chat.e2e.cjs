const { _electron: electron } = require('playwright-core')
const http = require('http')
const fs = require('fs'), path = require('path'), os = require('os')

const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const ANSWER = "Here's a quick example:\n\n```python\ndef greet(name):\n    return f\"Hello, {name}!\"\n```\n\nSome **bold** text, a list:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThat's it."
let lastBody = null, authSeen = null

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    authSeen = req.headers.authorization
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'cc/claude-opus-4-7' }, { id: 'cx/gpt-5.5' }, { id: 'gc/gemini-3-pro' }] }))
  }
  if (req.url === '/v1/chat/completions') {
    authSeen = req.headers.authorization
    let raw = ''; req.on('data', c => raw += c)
    req.on('end', () => {
      lastBody = JSON.parse(raw)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const toks = ANSWER.match(/.{1,4}/gs); let i = 0
      const t = setInterval(() => {
        if (i >= toks.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: toks[i++] } }] }) + '\n\n')
      }, 25)
      res.on('close', () => clearInterval(t))
    })
    return
  }
  res.writeHead(404); res.end()
})

const log = (...a) => console.log('•', ...a)
const check = (cond, msg) => { if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1 } else log('ok:', msg) }

;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria-'))
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ titles: { enabled: false } }))
  const launch = () => electron.launch({
    executablePath: process.env.TALARIA_BIN || ELECTRON,
    args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
  })
  let app = await launch()
  let win = await app.firstWindow()
  await win.setViewportSize({ width: 1180, height: 780 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', e => console.error('PAGE ERROR', e.message))
  win.on('console', m => m.type() === 'error' && console.error('CONSOLE', m.text()))

  // security posture
  const sec = await win.evaluate(() => ({ req: typeof require, proc: typeof process, api: typeof window.api }))
  check(sec.req === 'undefined' && sec.proc === 'undefined' && sec.api === 'object', 'renderer is isolated (no node), api bridge present')

  await win.screenshot({ path: path.join(SHOTS, '1-welcome.png') })

  // pick model through the picker
  await win.click('.picker-btn')
  await win.waitForSelector('.opt')
  const opts = await win.$$eval('.opt', els => els.map(e => e.textContent))
  check(opts.length === 3, `model list loaded from /models (${opts.join(', ')})`)
  await win.screenshot({ path: path.join(SHOTS, '2-model-picker.png') })
  await win.click('.opt:has-text("cc/claude-opus-4-7")')

  // send + stream
  await win.fill('.composer textarea', 'Write a greeting function')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.msg-assistant .caret, .msg-assistant .thinking')
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(SHOTS, '3-streaming.png') })
  await win.waitForSelector('.msg-assistant .md table', { timeout: 15000 })
  await win.waitForSelector('.msg-actions', { state: 'attached' })
  await win.waitForFunction(() => !document.querySelector('.caret'))
  check(lastBody.stream === true && lastBody.model === 'cc/claude-opus-4-7', 'request used selected model + stream:true')
  check(lastBody.messages[0].role === 'system' && lastBody.messages.at(-1).content === 'Write a greeting function', 'system prompt + user message sent')
  check(await win.$('.codeblock pre .hljs-keyword') !== null, 'code block syntax highlighted')
  await win.hover('.msg-assistant')
  await win.screenshot({ path: path.join(SHOTS, '4-answer.png') })

  // sidebar shows chat with auto title
  const title = await win.textContent('.conv.active .conv-title')
  check(title === 'Write a greeting function', `auto title: "${title}"`)

  // Stop mid-stream keeps partial text and no error
  await win.keyboard.press('Control+n')
  await win.fill('.composer textarea', 'Another one')
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent.length > 20)
  await win.click('.send.stop')
  await win.waitForFunction(() => !document.querySelector('.send.stop'))
  const partial = await win.textContent('.msg-assistant .md')
  check(partial.length > 10 && partial.length < ANSWER.length - 10 && !(await win.$('.msg-error')), `Stop keeps partial (${partial.length}/${ANSWER.length} chars), no error`)
  await win.waitForTimeout(400)
  const afterStop = await win.textContent('.msg-assistant .md')
  check(afterStop.length === partial.length, 'stream really stopped (no more text arrives)')

  // Settings: save a key, ensure renderer never gets it back, and it is sent as Bearer
  await win.keyboard.press('Control+,')
  await win.waitForSelector('.modal')
  await win.fill('.provider-form input[type=password]', 'sk-secret-123')
  await win.click('button:has-text("Test connection")')
  await win.waitForSelector('.status.ok')
  await win.screenshot({ path: path.join(SHOTS, '5-settings.png') })
  check(authSeen === 'Bearer sk-secret-123', 'test-connection used the typed (unsaved) key')
  await win.click('button:has-text("Save")')
  await win.waitForSelector('button:has-text("Saved")')
  const exposed = await win.evaluate(async () => JSON.stringify(await window.api.settings.get()))
  check(!exposed.includes('sk-secret-123') && exposed.includes('"hasKey":true'), 'API key never returned to renderer (hasKey only)')
  const onDisk = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')
  log('settings.json mode', (fs.statSync(path.join(userData, 'settings.json')).mode & 0o777).toString(8))
  log('key on disk', onDisk.includes('sk-secret-123') ? 'PLAINTEXT (no OS keyring in this container)' : 'encrypted')

  // Theme switch to light (Settings → Appearance)
  await win.click('.tabs button:has-text("Appearance")')
  await win.click('.segmented button:has-text("Light")')
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await win.screenshot({ path: path.join(SHOTS, '6-light.png') })
  await win.click('.segmented button:has-text("Dark")')
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await win.keyboard.press('Escape')

  // Server down -> friendly error + retry
  server.close(); server.closeAllConnections?.()
  await win.keyboard.press('Control+n')
  await win.fill('.composer textarea', 'hello?')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.msg-error')
  const errText = await win.textContent('.msg-error')
  check(/Could not reach/.test(errText), `server-down error is friendly: "${errText.slice(0, 80)}"`)
  await win.screenshot({ path: path.join(SHOTS, '7-error.png') })

  // Persistence across restart
  await app.close()
  app = await launch(); win = await app.firstWindow()
  await win.setViewportSize({ width: 1180, height: 780 })
  await win.waitForSelector('.conv')
  const n = await win.$$eval('.conv', e => e.length)
  check(n >= 2, `history persisted across restart (${n} chats)`)
  await win.click('.conv:has-text("Write a greeting function")')
  await win.waitForSelector('.msg-assistant .md table')
  check(true, 'old conversation reloads with rendered markdown')
  await win.screenshot({ path: path.join(SHOTS, '8-restarted.png') })
  await app.close()
  process.exit(process.exitCode || 0)
})().catch(e => { console.error('E2E CRASH', e); process.exit(1) })
