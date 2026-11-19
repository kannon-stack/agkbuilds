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
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'))
  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgs-'))
  fs.writeFileSync(path.join(dir, 'dot.png'), PNG1)
  fs.writeFileSync(path.join(dir, 'fake.png'), 'this is not a png')
  const pickStub = files => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f }) }, files)

  // picker: bad file rejected, good one accepted
  await pickStub([path.join(dir, 'fake.png')]); await win.click('[aria-label="Attach images"]')
  await win.waitForSelector('.toast:has-text("Only PNG")')
  check(await win.$$eval('.composer .thumb', e => e.length) === 0, 'non-image disguised as .png is rejected')
  await pickStub([path.join(dir, 'dot.png')]); await win.click('[aria-label="Attach images"]')
  await win.waitForSelector('.composer .thumb img')
  check(await win.$$eval('.composer .thumb', e => e.length) === 1, 'picked image shows as thumbnail')
  check(!(await win.isDisabled('.send')), 'send enabled with image only')
  // remove then re-add
  await win.click('.composer [aria-label="Remove dot.png"]')
  check(await win.$$eval('.composer .thumb', e => e.length) === 0 && await win.isDisabled('.send'), 'remove works; send disabled when empty')
  await pickStub([path.join(dir, 'dot.png')]); await win.click('[aria-label="Attach images"]'); await win.waitForSelector('.composer .thumb img')
  await win.keyboard.press('Escape')
  await win.focus('.composer textarea'); await win.keyboard.press('Enter'); await win.waitForTimeout(200); await settle()
  let b = bodies.at(-1).messages.filter(m => m.role === 'user').at(-1)
  check(Array.isArray(b.content) && b.content[0].type === 'image_url' && b.content[0].image_url.url.startsWith('data:image/png;base64,') && b.content.length === 1, 'image-only message sent as image_url part')
  check(await win.$$eval('.msg-user .thumb img', e => e.length) === 1 && await win.$$eval('.composer .thumb', e => e.length) === 0, 'thumbnail in thread, composer cleared')
  await win.click('.msg-user .thumb-img'); await win.waitForSelector('.lightbox img')
  await win.keyboard.press('Escape'); await win.waitForSelector('.lightbox', { state: 'detached' })
  check(true, 'lightbox opens and closes with Escape')

  // paste a big image: should be downscaled
  await win.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4200; c.height = 1500
    const ctx = c.getContext('2d'); for (let i = 0; i < 200; i++) { ctx.fillStyle = `hsl(${i*7},70%,50%)`; ctx.fillRect(i*21, (i*37)%1500, 60, 60) }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'big.png', { type: 'image/png' }))
    document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await win.waitForSelector('.composer .thumb img')
  const src = await win.$eval('.composer .thumb img', e => e.src)
  const dims = await win.evaluate(s => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = s }), src)
  check(dims[0] === 2048 && dims[1] === Math.round(1500 * 2048 / 4200), `pasted 4200x1500 downscaled to ${dims.join('x')}`)
  await win.fill('.composer textarea', 'describe this'); await win.keyboard.press('Enter'); await win.waitForTimeout(200); await settle()
  b = bodies.at(-1).messages.filter(m => m.role === 'user').at(-1)
  check(b.content.length === 2 && b.content[1].text === 'describe this', 'image + text sent')
  b = bodies.at(-1).messages.filter(m => m.role === 'user')
  check(Array.isArray(b[0].content), 'earlier image still included in history')

  // drop a non-image
  await win.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['hi'], 'a.txt', { type: 'text/plain' }))
    const el = document.querySelector('.composer'); el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await win.waitForSelector('.toast:has-text("Only PNG")'); check(true, 'dropping a non-image is refused')
  // too many
  const many = []; for (let i = 0; i < 7; i++) { const f = path.join(dir, `p${i}.png`); fs.writeFileSync(f, Buffer.concat([PNG1, Buffer.from([i])])); many.push(f) }
  await pickStub(many); await win.click('[aria-label="Attach images"]'); await win.waitForTimeout(500)
  check(await win.$$eval('.composer .thumb', e => e.length) === 6, 'capped at 6 images per message')
  check(await win.isDisabled('[aria-label="Attach images"]'), 'attach button disabled at the cap')
  for (let i = 0; i < 6; i++) await win.click('.composer .thumb-x >> nth=0')

  // persistence across restart
  const attDir = path.join(userData, 'attachments'); const nFiles = fs.readdirSync(attDir).length
  await app.close(); ;({ app, win } = await launch()); await win.waitForSelector('.msg-user .thumb img')
  check(await win.$$eval('.msg-user .thumb img', e => e.length) === 2, 'thumbnails reload after restart')

  // branch edit keeps images
  await win.hover('.msg-user >> nth=1'); await win.click('.msg-user >> nth=1 >> text=Edit'); await win.fill('.editor textarea', 'describe it differently')
  await win.click('text=Save & send'); await win.waitForTimeout(300); await settle()
  b = bodies.at(-1).messages.filter(m => m.role === 'user').at(-1)
  check(Array.isArray(b.content) && b.content[0].type === 'image_url' && b.content[1].text === 'describe it differently', 'edited message keeps its image')

  // search by file name
  await win.fill('.search', 'dot.png'); await win.waitForTimeout(400)
  check(await win.$$eval('.snippet', e => e.length) >= 1, 'search finds attachment file names')
  await win.fill('.search', '')

  // deleting the chat prunes (old) files
  for (const f of fs.readdirSync(attDir)) fs.utimesSync(path.join(attDir, f), new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3))
  win.on('dialog', d => d.accept())
  await win.hover('.conv.active'); await win.click('.conv.active .conv-del'); await win.waitForTimeout(1200)
  check(fs.readdirSync(attDir).length === 0, `unreferenced images pruned after deleting the chat (${nFiles} -> ${fs.readdirSync(attDir).length})`)
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
