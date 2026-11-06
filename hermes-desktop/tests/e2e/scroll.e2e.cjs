const { _electron: electron } = require('playwright-core')
const http = require('http')
const fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
let n = 0, bodies = []
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }] })) }
  if (req.url === '/v1/chat/completions') {
    let raw = ''; req.on('data', c => raw += c)
    req.on('end', () => {
      const b = JSON.parse(raw); bodies.push(b)
      const lc = b.messages.filter(m => m.role === 'user').at(-1).content; const last = typeof lc === 'string' ? lc : (lc.find(p => p.type === 'text')?.text ?? '(image only)')
      const text = `Reply#${++n} to: ${last}`
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
      res.write('data: [DONE]\n\n'); res.end()
    })
    return
  }
  res.writeHead(404); res.end()
})
const log = (...a) => console.log('•', ...a)
const check = (c, m) => { if (!c) { console.error('✗ FAIL:', m); process.exitCode = 1 } else log('ok:', m) }
;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria-'))
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ titles: { enabled: false } }))
  const launch = async () => {
    const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`] })
    const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 780 }); await win.waitForSelector('.sidebar')
    win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
    return { app, win }
  }
  let { app, win } = await launch()
  await win.setViewportSize({ width: 1000, height: 480 })
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'))
  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')
  for (let i = 0; i < 7; i++) { await win.fill('.composer textarea', `message number ${i}`); await win.keyboard.press('Enter'); await win.waitForTimeout(150); await settle() }
  const atBottom = () => win.$eval('.scroller', el => el.scrollHeight - el.scrollTop - el.clientHeight < 5)
  check(await atBottom() && await win.$('.to-latest') === null, 'pinned to bottom, no button')
  await win.$eval('.scroller', el => { el.scrollTop = 0 })
  await win.waitForSelector('.to-latest')
  check(true, 'button appears after scrolling up')
  await win.click('.to-latest')
  await win.waitForFunction(() => { const el = document.querySelector('.scroller'); return el.scrollHeight - el.scrollTop - el.clientHeight < 5 })
  await win.waitForSelector('.to-latest', { state: 'detached' })
  check(true, 'click scrolls to latest and hides the button')
  // new chat resets
  await win.$eval('.scroller', el => { el.scrollTop = 0 }); await win.waitForSelector('.to-latest')
  await win.keyboard.press('Control+n'); await win.waitForTimeout(300)
  check(await win.$('.to-latest') === null, 'button not shown in a fresh chat')
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
