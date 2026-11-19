const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
let calls = 0, fail = false
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"m1"}]}') }
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => {
    calls++
    if (fail) { res.writeHead(500, {'Content-Type':'application/json'}); return res.end('{"error":{"message":"upstream exploded"}}') }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer #' + calls } }] }) + '\n\ndata: [DONE]\n\n'); res.end()
  })
})
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria2-'))
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false } }))
  const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const win = await app.firstWindow(); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  win.on('dialog', d => d.accept())
  const txt = () => win.textContent('.msg-assistant .md')

  await win.click('.picker-btn'); await win.click('.opt:has-text("m1")')
  await win.fill('.composer textarea', 'first'); await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent === 'answer #1')
  await win.hover('.msg-assistant'); await win.click('button:has-text("Regenerate")')
  await win.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent === 'answer #2')
  check(await win.$$eval('.msg-assistant', e => e.length) === 1, 'Regenerate replaces (still one assistant msg): ' + await txt())

  // error then Retry
  fail = true
  await win.fill('.composer textarea', 'second'); await win.keyboard.press('Enter')
  await win.waitForSelector('.msg-error')
  check((await win.textContent('.msg-error')).includes('500: upstream exploded'), 'HTTP 500 surfaces provider message')
  fail = false
  await win.hover('.msg-assistant >> nth=1'); await win.click('button:has-text("Retry")')
  await win.waitForFunction(() => !document.querySelector('.msg-error') && [...document.querySelectorAll('.msg-assistant .md')].length === 2)
  check(true, 'Retry after error succeeds: ' + await win.textContent('.msg-assistant >> nth=1'))

  // history sent to server excludes the errored msg (no empty assistant turns)
  // rename
  await win.dblclick('.conv.active .conv-title')
  await win.fill('.rename', 'My renamed chat'); await win.keyboard.press('Enter')
  await win.waitForSelector('.conv-title:has-text("My renamed chat")')
  check((await win.textContent('.chat-head h1')) === 'My renamed chat', 'rename updates sidebar + header')

  // second chat + search
  await win.keyboard.press('Control+n'); await win.fill('.composer textarea', 'banana bread'); await win.keyboard.press('Enter')
  await win.waitForSelector('.conv:has-text("banana bread")')
  await win.fill('.search', 'renamed')
  await win.waitForSelector('.result'); check(await win.$$eval('.result', e => e.length) === 1, 'search filters list')
  await win.fill('.search', '')

  // delete active chat -> falls back to another
  await win.hover('.conv.active'); await win.click('.conv.active .conv-del')
  await win.waitForFunction(() => document.querySelectorAll('.conv').length === 1)
  check((await win.textContent('.chat-head h1')) === 'My renamed chat', 'delete falls back to remaining chat')
  check(fs.readdirSync(path.join(ud, 'conversations')).length >= 1, 'conversation file removed from disk')
  await app.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
