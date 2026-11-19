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
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'))
  const send = async t => { await win.fill('.composer textarea', t); await win.keyboard.press('Enter'); await win.waitForTimeout(200); await settle() }
  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')
  await send('alpha topic about pineapples'); await send('follow up zucchini')
  // edit the 2nd message => original (zucchini) becomes an inactive branch
  await win.hover('.msg-user >> nth=1'); await win.click('.msg-user >> nth=1 >> text=Edit')
  await win.fill('.editor textarea', 'follow up broccoli'); await win.click('text=Save & send'); await win.waitForTimeout(300); await settle()
  await win.keyboard.press('Control+n')
  await send('beta topic about kayaks')
  const order = () => win.$$eval('.conv .conv-title', e => e.map(x => x.textContent))
  const orderBefore = await order()

  const q = async v => { await win.fill('.search', v); await win.waitForTimeout(400) }
  await q('pineapples')
  check(await win.$$eval('.result', e => e.length) === 1 && await win.$eval('.result mark', e => e.textContent) === 'pineapples', 'finds text in a message body (title is different)')
  await q('kayaks pineapples')
  check(await win.$$eval('.result', e => e.length) === 0 && await win.isVisible('.results >> text=No matches'), 'AND across terms; no cross-chat match')
  await q('zucchini')
  check(await win.$$eval('.result', e => e.length) === 1 && await win.isVisible('.snippet-branch'), 'finds text on an inactive branch and labels it')
  await win.click('.snippet')
  await win.waitForFunction(() => [...document.querySelectorAll('.msg-user .bubble')].some(b => b.textContent.includes('zucchini')))
  const vis = await win.$$eval('.msg-user .bubble', e => e.map(x => x.textContent))
  check(vis.includes('follow up zucchini') && !vis.includes('follow up broccoli'), 'clicking a hit switches to that branch')
  check(await win.evaluate(() => new Promise(r => { const t0 = Date.now(); const i = setInterval(() => { if (document.querySelector('.flash') || Date.now() - t0 > 1500) { clearInterval(i); r(!!document.querySelector('.flash')) } }, 30) })), 'message flashes')
  await win.waitForFunction(() => !document.querySelector('.flash'), null, { timeout: 4000 })
  check(await win.textContent('.chat-head h1') === 'alpha topic about pineapples', 'opened the right chat')
  await win.fill('.search', ''); await win.waitForTimeout(300)
  check(JSON.stringify(await order()) === JSON.stringify(orderBefore), 'revealing did not reorder the sidebar')
  check(await win.$('.results') === null, 'clearing search restores the list')
  // result for a hit in the other chat
  await q('KAYAKS')
  await win.click('.snippet')
  await win.waitForFunction(() => document.querySelector('.chat-head h1').textContent.startsWith('beta'))
  check(true, 'case-insensitive, opens other chat')
  // Escape clears
  await win.focus('.search'); await win.keyboard.press('Escape')
  check((await win.inputValue('.search')) === '', 'Escape clears search')
  // special chars safe
  await q('((['); check(await win.isVisible('.results >> text=No matches'), 'regex-ish input is literal')
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
