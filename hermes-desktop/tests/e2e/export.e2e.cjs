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
  check(await win.$('.export-menu') === null, 'no export menu on an empty chat')
  await send('hello export'); await send('second line')
  // edit => other branch that must not appear in export
  await win.hover('.msg-user >> nth=1'); await win.click('.msg-user >> nth=1 >> text=Edit')
  await win.fill('.editor textarea', 'second EDITED'); await win.click('text=Save & send'); await win.waitForTimeout(300); await settle()

  const out = path.join(userData, 'export-out'); fs.mkdirSync(out)
  const stub = (file) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => (f ? { canceled: false, filePath: f } : { canceled: true }) }, file)
  const menu = async (item) => { await win.click('.export-menu .icon-btn'); await win.click(`.menu >> text=${item}`) }

  await stub(path.join(out, 'a.md')); await menu('Save as Markdown')
  await win.waitForSelector('.toast:has-text("Saved to")')
  const md = fs.readFileSync(path.join(out, 'a.md'), 'utf8')
  check(md.startsWith('# hello export') && md.includes('second EDITED') && md.includes('Reply#') && !md.includes('\nsecond line\n'), 'markdown has visible branch only')
  await stub(path.join(out, 'a.json')); await menu('Save as JSON')
  await win.waitForSelector('.toast:has-text("a.json")')
  const js = JSON.parse(fs.readFileSync(path.join(out, 'a.json'), 'utf8'))
  check(js.messages.length === 6 && js.messages.some(x => x.content === 'second line'), 'json has all branches (' + js.messages.length + ')')
  await stub(null); await menu('Save as Markdown')
  await win.waitForTimeout(500)
  check(!fs.existsSync(path.join(out, 'b.md')) && await win.$('.toast:has-text("rror")') === null, 'cancelling the dialog is silent')
  await menu('Copy as Markdown')
  await win.waitForSelector('.toast:has-text("Copied")')
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(clip.startsWith('# hello export') && clip.includes('second EDITED'), 'clipboard has markdown')
  await win.click('.export-menu .icon-btn'); await win.keyboard.press('Escape')
  check(await win.$('.menu') === null, 'Escape closes menu')
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
