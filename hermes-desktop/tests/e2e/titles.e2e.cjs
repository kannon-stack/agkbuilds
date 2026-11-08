const { _electron: electron } = require('playwright-core')
const http = require('http')
const fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
let reqs = [], titleN = 0, titleDelay = 0, titleFail = false
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'tiny' }] })) }
  if (req.url === '/v1/chat/completions') {
    let raw = ''; req.on('data', c => raw += c)
    req.on('end', () => {
      const b = JSON.parse(raw); const sys = b.messages[0].role === 'system' ? b.messages[0].content : ''
      const isTitle = sys.includes('short titles for chat')
      reqs.push({ b, isTitle, user: b.messages.at(-1).content })
      const send = () => {
        if (isTitle && titleFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'title model exploded' } })) }
        const text = isTitle ? ['"Python Greeting Function."', 'Title: Second Idea', 'Edited Topic Title', 'Late Title', 'Fresh Regenerated'][Math.min(titleN++, 4)] : 'Sure — here is the answer text.'
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end()
      }
      isTitle && titleDelay ? setTimeout(send, titleDelay) : send()
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
  const launch = async () => {
    const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`] })
    const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 800 }); await win.waitForSelector('.sidebar')
    win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
    return { app, win }
  }
  let { app, win } = await launch()
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'))
  const send = async t => { await win.fill('.composer textarea', t); await win.keyboard.press('Enter'); await win.waitForTimeout(200); await settle() }
  const head = () => win.textContent('.chat-head h1, .chat-head .title-input').catch(() => '')
  const titleReqs = () => reqs.filter(r => r.isTitle)
  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')

  // 1. placeholder, then generated
  titleDelay = 700
  const q = 'please write a greeting function in python that takes a name'
  await win.fill('.composer textarea', q); await win.keyboard.press('Enter')
  await win.waitForSelector('.chat-head h1')
  check((await head()).startsWith('please write a greeting'), 'placeholder title appears immediately: ' + (await head()))
  await win.waitForFunction(() => document.querySelector('.chat-head h1')?.textContent === 'Python Greeting Function')
  titleDelay = 0
  check(true, 'model title replaces it (quotes + period cleaned)')
  check(await win.textContent('.conv.active .conv-title') === 'Python Greeting Function', 'sidebar updated')
  const tr = titleReqs()[0]
  check(tr.user.includes('please write a greeting') && tr.user.includes('Sure — here is the answer text.'), 'title prompt had the first exchange')
  await settle(); await send('and one in rust')
  check(titleReqs().length === 1, 'no second title request after a generated title')

  // 2. manual rename sticks
  await win.dblclick('.chat-head h1'); await win.fill('.title-input', 'My own name'); await win.keyboard.press('Enter')
  await win.waitForFunction(() => document.querySelector('.chat-head h1')?.textContent === 'My own name')
  check(await win.textContent('.conv.active .conv-title') === 'My own name', 'header rename shows in sidebar')
  await send('third message'); await win.waitForTimeout(400)
  check((await head()) === 'My own name' && titleReqs().length === 1, 'typed title survives later turns')
  // Escape cancels
  await win.dblclick('.chat-head h1'); await win.fill('.title-input', 'discard me'); await win.keyboard.press('Escape')
  check((await head()) === 'My own name', 'Escape cancels rename')

  // 3. regenerate title overrides a typed one
  await win.click('.export-menu .icon-btn'); await win.click('.menu >> text=Regenerate title')
  await win.waitForFunction(() => document.querySelector('.chat-head h1')?.textContent !== 'My own name', null, { timeout: 8000 })
  const regen = await head(); check(regen === 'Second Idea', 'Regenerate title replaced it: ' + regen)
  check(titleReqs().length === 2, 'regenerate made exactly one request')

  // 4. race: user renames while the title is being written
  titleDelay = 1500
  await win.keyboard.press('Control+n')
  await win.fill('.composer textarea', 'race condition question'); await win.keyboard.press('Enter'); await settle()
  await win.dblclick('.conv.active'); await win.fill('.rename', 'Mine'); await win.keyboard.press('Enter')
  await win.waitForTimeout(2200)
  check(await win.textContent('.conv.active .conv-title') === 'Mine' && (await head()) === 'Mine', 'rename during title generation wins')
  titleDelay = 0

  // 5. editing the opening message re-derives, then retitles
  await win.keyboard.press('Control+n')
  await send('original opening'); await win.waitForFunction(() => document.querySelector('.chat-head h1')?.textContent === 'Late Title' || document.querySelector('.chat-head h1')?.textContent === 'Edited Topic Title')
  const before = await head()
  await win.hover('.msg-user >> nth=0'); await win.click('.msg-user >> nth=0 >> text=Edit'); await win.fill('.editor textarea', 'completely different topic'); await win.click('text=Save & send')
  await win.waitForFunction(b => document.querySelector('.chat-head h1')?.textContent !== b, before, { timeout: 8000 })
  check((await head()) !== before, `editing the first message retitled (${before} → ${await head()})`)

  // 6. failure leaves the placeholder, no error shown
  await win.waitForSelector('.toast', { state: 'detached', timeout: 8000 }).catch(() => {})
  titleFail = true
  await win.keyboard.press('Control+n'); await send('this title request will fail')
  await win.waitForTimeout(500)
  check((await head()).startsWith('this title request') && await win.$('.msg-error') === null && await win.$('.toast') === null, 'title failure is silent; placeholder kept')
  titleFail = false

  // 7. settings: model override + disable
  await win.evaluate(() => window.api.settings.update({ titles: { model: 'tiny' } }))
  await win.reload(); await win.waitForSelector('.composer textarea'); await win.keyboard.press('Control+n')
  const n0 = titleReqs().length
  await send('use the small model for the title'); await win.waitForFunction(n => document.querySelectorAll('.conv').length > 0, 0)
  await win.waitForTimeout(800)
  check(titleReqs().length === n0 + 1 && titleReqs().at(-1).b.model === 'tiny', 'title uses the override model: ' + titleReqs().at(-1).b.model)
  check(reqs.filter(r => !r.isTitle).at(-1).b.model === 'm1', 'chat itself still used its own model')
  await win.evaluate(() => window.api.settings.update({ titles: { enabled: false } }))
  await win.keyboard.press('Control+n'); const n1 = titleReqs().length
  await send('titles are disabled now'); await win.waitForTimeout(600)
  check(titleReqs().length === n1 && (await head()).startsWith('titles are disabled'), 'disabled: no title request, placeholder stays')

  // 8. Settings UI
  await win.reload(); await win.waitForSelector('.composer textarea')
  await win.keyboard.press('Control+,'); await win.waitForSelector('.settings-page')
  await win.click('text=General'); await win.waitForSelector('text=Chat titles')
  check(!(await win.$$eval('label.check input[type=checkbox]', e => e.map(x => x.checked))).slice(0,1)[0], 'settings toggle reflects disabled')
  await win.click('text=Let the model name new chats'); await win.waitForTimeout(400)
  check((await win.evaluate(() => window.api.settings.get())).titles.enabled === true, 'toggling saves')
  await win.keyboard.press('Escape')

  // 9. persistence + search
  await app.close(); ;({ app, win } = await launch()); await win.waitForSelector('.conv')
  const titles = await win.$$eval('.conv .conv-title', e => e.map(x => x.textContent))
  check(titles.includes('Mine') && titles.includes('Second Idea'), 'titles persist: ' + titles.join(' | '))
  await win.fill('.search', 'Second Idea'); await win.waitForTimeout(400)
  check(await win.$$eval('.result', e => e.length) >= 1, 'search finds chats by generated title')
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
