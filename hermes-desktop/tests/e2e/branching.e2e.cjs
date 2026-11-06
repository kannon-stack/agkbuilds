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
      const last = b.messages.filter(m => m.role === 'user').at(-1).content
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
  const texts = () => win.$$eval('.msg', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'))
  const send = async t => { await win.fill('.composer textarea', t); await win.keyboard.press('Enter'); await win.waitForTimeout(200); await settle() }

  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')
  await send('first question'); await send('second question')
  let t = await texts()
  check(t.length === 4 && t[1].includes('Reply#1 to: first question') && t[3].includes('Reply#2 to: second question'), 'two turns shown')

  // Edit the first message -> new branch, old preserved
  await win.hover('.msg-user >> nth=0')
  await win.click('.msg-user >> nth=0 >> text=Edit')
  await win.waitForSelector('.editor textarea')
  await win.fill('.editor textarea', 'first question EDITED')
  await win.click('text=Save & send'); await win.waitForTimeout(300); await settle()
  t = await texts()
  check(t.length === 2 && t[0].includes('EDITED') && t[1].includes('Reply#3 to: first question EDITED'), 'edit replaces the visible branch')
  check(bodies.at(-1).messages.filter(m => m.role === 'user').length === 1, 'edited request has no stale later turns')
  let nav = await win.textContent('.msg-user >> nth=0 >> .branch-nav')
  check(/2\s*\/\s*2/.test(nav), `branch nav shows ${nav.trim()}`)

  // Switch back to the original branch
  await win.hover('.msg-user >> nth=0')
  await win.click('.msg-user >> nth=0 >> [aria-label="Previous version"]')
  await win.waitForFunction(() => document.querySelectorAll('.msg').length === 4)
  t = await texts()
  check(t[0].includes('first question') && !t[0].includes('EDITED') && t[3].includes('Reply#2'), 'switching back restores the original conversation')

  // Continue on original branch, then regenerate last answer -> variants
  await send('third question')
  t = await texts(); check(t.length === 6, 'continued on old branch')
  await win.hover('.msg-assistant >> nth=-1')
  await win.click('.msg-assistant >> nth=-1 >> text=Regenerate'); await win.waitForTimeout(300); await settle()
  t = await texts()
  check(t.length === 6 && t[5].includes('third question') && !t[5].includes('Reply#4'), 'regenerate yields a new answer: ' + t[5].slice(0, 60))
  nav = await win.textContent('.msg-assistant >> nth=-1 >> .branch-nav')
  check(/2\s*\/\s*2/.test(nav), 'answer variants 2/2')
  await win.hover('.msg-assistant >> nth=-1')
  await win.click('.msg-assistant >> nth=-1 >> [aria-label="Previous version"]')
  await win.waitForFunction(() => document.querySelector('.msg-assistant:last-of-type, .msg:last-child')?.textContent.includes('Reply#4'))
  check(true, 'can flip to the earlier answer')

  // Buttons disabled while generating? (slow check skipped: server is instant) -> persistence across restart
  const before = await texts()
  await app.close()
  ;({ app, win } = await launch())
  await win.waitForSelector('.msg')
  const after = await texts()
  check(JSON.stringify(before) === JSON.stringify(after), 'visible branch persists across restart')
  nav = await win.textContent('.msg-assistant >> nth=-1 >> .branch-nav')
  check(/1\s*\/\s*2/.test(nav), 'sibling info persists')
  await app.close()

  // Legacy linear file loads
  const dir = path.join(userData, 'conversations'); fs.mkdirSync(dir, { recursive: true })
  const legacy = { id: 'legacy-1', title: 'Old chat', createdAt: Date.now() + 5000, updatedAt: Date.now() + 5000, messages: [
    { id: 'l1', role: 'user', content: 'old q', createdAt: 1 }, { id: 'l2', role: 'assistant', content: 'old a', createdAt: 2 } ] }
  fs.writeFileSync(path.join(dir, 'legacy-1.json'), JSON.stringify(legacy))
  ;({ app, win } = await launch())
  await win.click('.conv:has-text("Old chat")')
  await win.waitForFunction(() => document.querySelectorAll('.msg').length === 2)
  check((await texts())[1].includes('old a'), 'legacy conversation (no tree fields) loads')
  await send('new on legacy')
  t = await texts(); check(t.length === 4 && t[2].includes('new on legacy'), 'can continue a legacy chat')
  await app.close()
  server.close()
})().catch(e => { console.error(e); process.exit(1) })
