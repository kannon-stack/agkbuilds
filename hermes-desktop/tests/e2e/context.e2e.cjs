const { _electron: electron } = require('playwright-core')
const http = require('http')
const fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
let reqs = [], limitTokens = 0, sumN = 0
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }] })) }
  if (req.url === '/v1/chat/completions') {
    let raw = ''; req.on('data', c => raw += c)
    req.on('end', () => {
      const b = JSON.parse(raw)
      const sys = b.messages[0].role === 'system' ? b.messages[0].content : ''
      const isSummary = sys.includes('condense conversations')
      const tokens = raw.length / 3.6
      reqs.push({ b, sys, isSummary, tokens, last: b.messages.at(-1).content })
      if (limitTokens && tokens > limitTokens) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${limitTokens} tokens. However, your messages resulted in ${Math.round(tokens)} tokens.` } }))
      }
      const text = isSummary ? `SUMMARY-${++sumN}: key facts about the talk` : 'ok ' + 'reply text '.repeat(70)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end()
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
  const settle = () => win.waitForFunction(() => !document.querySelector('.send.stop') && !document.querySelector('.caret'), null, { timeout: 30000 })
  // Wait until the message is really in the thread before waiting for the reply; otherwise a fast check can pass before
  // generation starts and the next send is refused ("already being generated"), silently shortening the conversation.
  const send = async t => {
    const n = await win.$$eval('.msg-user', e => e.length)
    await win.fill('.composer textarea', t); await win.keyboard.press('Enter')
    await win.waitForFunction(n => document.querySelectorAll('.msg-user').length > n, n, { timeout: 15000 })
    await settle()
  }
  const big = (tag) => `${tag} ` + 'lorem ipsum dolor sit amet '.repeat(95) // ~2.5k chars
  const normal = () => reqs.filter(r => !r.isSummary)
  const summaries = () => reqs.filter(r => r.isSummary)

  await win.click('.picker-btn'); await win.waitForSelector('.opt'); await win.click('.opt:has-text("m1")')
  await win.evaluate(() => window.api.settings.update({ context: { window: 8192 }, tools: { enabled: false }, memory: { enabled: false } }))
  await win.reload(); await win.waitForSelector('.sidebar'); await win.waitForSelector('.composer textarea')

  // ---- automatic summarizing
  for (let i = 0; i < 6; i++) await send(big(`turn${i}`))
  if (!summaries().length) console.log('diagnostics:', JSON.stringify({ requests: reqs.length, users: await win.$$eval('.msg-user', e => e.length), toast: await win.$eval('.toast', e => e.textContent).catch(() => null), meter: await win.textContent('.ctx-chip').catch(() => null), settings: (await win.evaluate(() => window.api.settings.get())).context }))
  check(summaries().length >= 1, `auto-summarized (${summaries().length} summarizer request(s))`)
  await win.waitForSelector('[data-testid=compaction]')
  const divTxt = await win.textContent('[data-testid=compaction]')
  check(/Automatically summarized \d+ earlier messages?/.test(divTxt), 'divider says: ' + divTxt.slice(0, 70))
  check(await win.$$eval('.msg-user', e => e.length) === 6 && await win.$$eval('.msg-assistant', e => e.length) === 6, 'full chat still visible')
  const lastN = normal().at(-1)
  check(lastN.sys.includes('Earlier in this conversation (summarized)') && /SUMMARY-\d/.test(lastN.sys), 'summary injected into the system prompt')
  check(!lastN.b.messages.some(m => typeof m.content === 'string' && m.content.startsWith('turn0 ')), 'oldest turn no longer sent verbatim')
  check(lastN.b.messages.at(-2)?.content.startsWith('turn5 ') || lastN.b.messages.at(-1).content.startsWith('turn5 '), 'latest turn sent verbatim')
  await win.click('[data-testid=compaction] >> nth=0 >> text=View summary'); check(/SUMMARY-\d/.test(await win.textContent('.compaction-text')), 'summary viewable')
  await win.click('[data-testid=compaction] >> nth=0 >> text=Hide summary')

  // ---- meter
  await win.click('.ctx-chip'); await win.waitForSelector('.ctx-pop')
  const pop = await win.textContent('.ctx-pop')
  check(/of 8,192 tokens/.test(pop) && /set in Settings/.test(pop) && /Summarized 1×/.test(pop), 'meter popover: window + source + count')
  await win.keyboard.press('Escape'); check(await win.$('.ctx-pop') === null, 'Escape closes meter')

  // ---- /compact with focus text; folds previous summary
  const before = summaries().length
  await win.fill('.composer textarea', '/compact focus on the database choices'); await win.keyboard.press('Enter')
  await win.waitForSelector('.toast:has-text("Summarized")'); 
  check(summaries().length === before + 1, '/compact made one summarizer call')
  const s = summaries().at(-1)
  check(s.last.includes('focus on the database choices') && s.last.includes('<previous_summary>'), 'focus text + previous summary included')
  check(await win.$$eval('[data-testid=compaction]', e => e.length) === 2, 'second divider shown (manual)')

  // ---- editing before the summary branches away from it
  await win.hover('.msg-user >> nth=0'); await win.click('.msg-user >> nth=0 >> text=Edit'); await win.fill('.editor textarea', 'brand new start'); await win.click('text=Save & send'); await win.waitForTimeout(300); await settle()
  const br = normal().at(-1)
  check(!br.sys.includes('summarized') && br.b.messages.length === 2, 'edited branch has no summary and only its own messages')
  check(await win.$$eval('[data-testid=compaction]', e => e.length) === 0, 'no dividers on the new branch')
  await win.click('.msg-user >> nth=0 >> [aria-label="Previous version"]')
  await win.waitForSelector('[data-testid=compaction]'); check(true, 'switching back restores the summarized branch')

  // ---- persistence
  await app.close(); ;({ app, win } = await launch()); await win.waitForSelector('[data-testid=compaction]')
  check(await win.$$eval('[data-testid=compaction]', e => e.length) === 2, 'dividers persist across restart')

  // ---- nothing to compact in a short chat
  await win.keyboard.press('Control+n'); await send('just one turn')
  await win.fill('.composer textarea', '/compact'); await win.keyboard.press('Enter')
  await win.waitForSelector('.toast:has-text("Nothing to compact")'); check(true, 'short chat: friendly "nothing to compact"')

  // ---- overflow recovery: window unknown (128k guess), server enforces 4000 tokens
  await win.evaluate(() => window.api.settings.update({ context: { window: 0 } }))
  await win.reload(); await win.waitForSelector('.composer textarea')
  await win.keyboard.press('Control+n')
  for (let i = 0; i < 4; i++) await send(big(`ovf${i}`))
  limitTokens = 4000; const n0 = reqs.length
  await send(big('ovf4'))
  const after = reqs.slice(n0)
  check(after[0].tokens > 4000 && !after[0].isSummary, 'first attempt was rejected as too long')
  check(after.some(r => r.isSummary), 'recovery summarized older messages')
  const okReq = after.filter(r => !r.isSummary).at(-1)
  check(okReq.tokens <= 4000 && okReq.sys.includes('SUMMARY-'), `retry fit the learned limit (${Math.round(okReq.tokens)} tokens)`)
  check(await win.$$eval('.msg-error', e => e.length) === 0 && await win.$$eval('.msg-assistant', e => e.length) === 5, 'turn completed without an error card')
  await win.click('.ctx-chip'); check(/learned from a provider error/.test(await win.textContent('.ctx-pop')), 'meter now uses the learned window')
  limitTokens = 0
  await app.close(); server.close()
})().catch(e => { console.error(e); process.exit(1) })
