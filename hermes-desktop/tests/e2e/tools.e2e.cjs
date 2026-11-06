const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const bodies = []

const sse = (res, deltas, gap = 8) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let i = 0
  const t = setInterval(() => {
    if (i >= deltas.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + '\n\n')
  }, gap)
  res.on('close', () => clearInterval(t))
}
// Streams a tool call split into small argument fragments, like real providers.
const toolCall = (res, calls, lead = '') => {
  const d = []
  if (lead) d.push({ content: lead })
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.args)
    d.push({ tool_calls: [{ index, id: `call_${index}_${Date.now()}`, type: 'function', function: { name: c.name, arguments: '' } }] })
    for (let i = 0; i < args.length; i += 9) d.push({ tool_calls: [{ index, function: { arguments: args.slice(i, i + 9) } }] })
  })
  sse(res, d)
}
const text = (res, t) => sse(res, t.match(/.{1,5}/gs).map(content => ({ content })))

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"tool-model"}]}') }
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => {
    const body = JSON.parse(raw); bodies.push(body)
    const msgs = body.messages, last = msgs.at(-1)
    if (last.role === 'user') {
      const q = last.content
      if (q === 'A') return toolCall(res, [{ name: 'list_dir', args: { path: '.' } }, { name: 'read_file', args: { path: 'notes.txt' } }], 'Looking around. ')
      if (q === 'B') return toolCall(res, [{ name: 'write_file', args: { path: 'out/hello.txt', content: 'Hello from the model\n' } }])
      if (q === 'C') return toolCall(res, [{ name: 'run_command', args: { command: 'echo nope > ran.txt' } }])
      if (q === 'D') return toolCall(res, [{ name: 'run_command', args: { command: 'echo one' } }])
      if (q === 'D2') return toolCall(res, [{ name: 'run_command', args: { command: 'echo two' } }])
      if (q === 'E') return toolCall(res, [{ name: 'run_command', args: { command: 'echo e > e.txt' } }])
      if (q === 'F') return toolCall(res, [{ name: 'write_file', args: { path: '../escape.txt', content: 'x' } }])
      if (q === 'G') return toolCall(res, [{ name: 'edit_file', args: { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' } }])
      if (q === 'H') return toolCall(res, [{ name: 'run_command', args: { command: 'sleep 30' } }])
      return text(res, 'plain reply to ' + q)
    }
    if (last.role === 'tool') {
      const n = msgs.filter((m, i) => m.role === 'tool' && i > msgs.map(x => x.role).lastIndexOf('user')).length
      return text(res, `Finished with ${n} tool result(s): ${String(last.content).slice(0, 50).replace(/\n/g, ' ')}`)
    }
    text(res, 'ok')
  })
})

const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria3-'))
  const ws = path.join(root, 'proj'); fs.mkdirSync(ws)
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'alpha\nbeta\ngamma\n')
  const ud = path.join(root, 'ud'); fs.mkdirSync(ud)
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, tools: { enabled: true, workspace: ws, policies: {} }, providers: [{ id: 'default', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'tool-model' }], activeProviderId: 'default' }))

  const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 820 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  const ask = async (q, first = false) => { if (!first) await win.keyboard.press('Control+n'); await win.fill('.composer textarea', q); await win.keyboard.press('Enter') }
  const idle = () => win.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 15000 })
  const lastText = () => win.evaluate(() => [...document.querySelectorAll('.msg-assistant .md')].at(-1)?.textContent ?? '')

  check(await win.textContent('.chip') .then(t => t.includes('proj')), 'composer chip shows workspace folder name')

  // A: read-only tools run automatically (no approval), 2 calls in one turn, then a final answer
  await ask('A', true); await idle()
  check(await win.$('.tool-awaiting_approval') === null, 'A: read-only tools inside workspace did not ask')
  check(await win.$$eval('.tool-done', e => e.length) === 2, 'A: two tool cards, both done')
  check((await lastText()).includes('Finished with 2 tool result(s)'), 'A: model saw both results and answered: ' + await lastText())
  const wireA = bodies.at(-1).messages
  const asst = wireA.find(m => m.role === 'assistant' && m.tool_calls)
  check(asst && asst.tool_calls.length === 2 && wireA.filter(m => m.role === 'tool').length === 2 && wireA.filter(m => m.role === 'tool').every(m => asst.tool_calls.some(c => c.id === m.tool_call_id)), 'A: wire format = assistant.tool_calls + matching tool messages')
  check(wireA.filter(m => m.role === 'tool').some(m => m.content.includes('alpha')), 'A: file contents reached the model')
  check(['read_file','list_dir','write_file','edit_file','run_command','web_fetch'].every(n => bodies.at(-1).tools?.some(t => t.function.name === n)) && wireA[0].role === 'system' && wireA[0].content.includes(ws), 'A: all 6 built-in tool defs sent; system prompt names the workspace')

  // B: write needs approval; nothing written until Allow
  await ask('B')
  await win.waitForSelector('.tool-awaiting_approval')
  check(!fs.existsSync(path.join(ws, 'out/hello.txt')), 'B: file NOT written while awaiting approval')
  await win.screenshot({ path: path.join(SHOTS, '9-approval.png') })
  await win.click('button:has-text("Allow once")'); await idle()
  check(fs.readFileSync(path.join(ws, 'out/hello.txt'), 'utf8') === 'Hello from the model\n', 'B: file written after Allow once')
  await win.screenshot({ path: path.join(SHOTS, '10-tool-done.png') })

  // C: deny -> command never runs, model is told
  await ask('C'); await win.waitForSelector('.tool-awaiting_approval')
  await win.click('.tool-approve button:has-text("Deny")'); await idle()
  check(!fs.existsSync(path.join(ws, 'ran.txt')), 'C: denied command did not run')
  check(bodies.at(-1).messages.at(-1).content.includes('denied'), 'C: model received "user denied" result')
  check(await win.$('.tool-denied') !== null, 'C: card shows Denied')

  // D: allow for this chat -> second command in the same chat runs without asking
  await ask('D'); await win.waitForSelector('.tool-awaiting_approval')
  await win.click('button:has-text("Allow for this chat")'); await idle()
  check((await win.textContent('.tool-pre >> nth=-1')).includes('one'), 'D: command output captured')
  await win.fill('.composer textarea', 'D2'); await win.keyboard.press('Enter'); await idle()
  check(await win.$('.tool-awaiting_approval') === null && (await win.$$eval('.tool-done', e => e.length)) === 2, 'D: 2nd run_command in same chat ran without asking')
  // ...but a NEW chat asks again
  await ask('D2'); await win.waitForSelector('.tool-awaiting_approval'); check(true, 'D: new chat asks again')
  await win.click('.tool-approve button:has-text("Deny")'); await idle()

  // F: write outside workspace is refused up-front, without any approval prompt
  await ask('F'); await idle()
  check(await win.$('.tool-awaiting_approval') === null && !fs.existsSync(path.join(root, 'escape.txt')), 'F: outside-workspace write refused with no prompt, nothing written')
  check(bodies.at(-1).messages.at(-1).content.includes('outside the workspace'), 'F: model told why')

  // G: edit shows diff preview, then applies
  await ask('G'); await win.waitForSelector('.tool-awaiting_approval')
  check(await win.$('.tool-pre.del') !== null && await win.$('.tool-pre.add') !== null, 'G: edit approval shows old/new preview')
  await win.click('button:has-text("Allow once")'); await idle()
  check(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8') === 'alpha\nBETA\ngamma\n', 'G: edit applied')

  // E: Stop while awaiting approval -> no hang, no execution, history stays valid
  await ask('E'); await win.waitForSelector('.tool-awaiting_approval')
  await win.click('.send.stop'); await idle()
  check(!fs.existsSync(path.join(ws, 'e.txt')), 'E: Stop while awaiting approval: command never ran')
  check(await win.$('.msg-error') === null, 'E: no error state after Stop')
  await win.fill('.composer textarea', 'follow up'); await win.keyboard.press('Enter'); await idle()
  const w = bodies.at(-1).messages
  const idx = w.findIndex(m => m.role === 'assistant' && m.tool_calls)
  check(idx > 0 && w[idx + 1].role === 'tool' && /Cancelled/.test(w[idx + 1].content), 'E: next request has a (cancelled) tool result for the dangling call')
  check((await lastText()).includes('plain reply to follow up'), 'E: conversation continues normally')

  // H: Stop while a command is RUNNING kills it
  await win.keyboard.press('Control+n'); await win.fill('.composer textarea', 'H'); await win.keyboard.press('Enter')
  await win.waitForSelector('.tool-awaiting_approval'); await win.click('button:has-text("Allow once")')
  await win.waitForSelector('.tool-running')
  const t0 = Date.now(); await win.click('.send.stop'); await idle()
  check(Date.now() - t0 < 4000, `H: Stop killed a running 'sleep 30' in ${Date.now() - t0}ms`)

  // persistence: tool cards survive restart
  await app.close()
  const app2 = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const w2 = await app2.firstWindow(); await w2.setViewportSize({ width: 1180, height: 820 }); await w2.waitForSelector('.conv')
  await w2.click('.conv:has-text("B")')
  await w2.waitForSelector('.tool')
  check((await w2.$$eval('.tool-done', e => e.length)) === 1, 'tool cards persisted across restart')
  await app2.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
