const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const BIN = process.env.TALARIA_BIN
const claudeReqs = [], openaiReqs = []

const chunk = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'gs')) ?? ['']
function sse(blocks, { stop = 'end_turn', details, usage = {}, model }) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }), i = 0
  for (const b of blocks) {
    if (b.type === 'thinking') { out += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }); for (const c of chunk(b.text, 5)) out += ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: c } }); out += ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } }) }
    else if (b.type === 'text') { out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }); for (const c of chunk(b.text, 4)) out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c } }) }
    else { out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); for (const c of chunk(JSON.stringify(b.input), 9)) out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c } }) }
    out += ev('content_block_stop', { index: i }); i++
  }
  return out + ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...(details ? { stop_details: details } : {}) }, usage: { output_tokens: 42, ...usage } }) + ev('message_stop', {})
}
const lastUserText = (b) => { const m = [...b.messages].reverse().find(x => x.role === 'user'); const c = m.content; return typeof c === 'string' ? c : c.filter(x => x.type === 'text').map(x => x.text).join('') }
const lastIsToolResult = (b) => { const m = b.messages.at(-1); return m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result' }

const claude = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => {
    const p = req.url.split('?')[0], body = raw ? JSON.parse(raw) : undefined
    const json = (s, o, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)) }
    if (p === '/v1/models') return json(200, { data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].map(id => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: 'a', last_id: 'b' })
    if (p.startsWith('/v1/models/')) return json(200, { id: p.split('/').pop(), type: 'model', display_name: 'X', created_at: '2026-01-01T00:00:00Z', max_tokens: 128000, max_input_tokens: 1000000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true } } })
    if (p !== '/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'x' } })
    claudeReqs.push({ headers: req.headers, body })
    const q = lastUserText(body), model = body.model
    if (q.includes('ERR401')) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { 'x-should-retry': 'false' })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (q.includes('HANG')) { const t = sse([{ type: 'text', text: 'Partial answer that will be interrupted for sure.' }], { model }); res.write(t.slice(0, t.indexOf('event: content_block_stop'))); return }
    if (lastIsToolResult(body)) return res.end(sse([{ type: 'text', text: 'The file says: ' + body.messages.at(-1).content[0].content.slice(0, 30) }], { model, usage: { cache_read_input_tokens: 60 } }))
    if (q.includes('T1')) return res.end(sse([{ type: 'thinking', text: 'I should read notes.txt.', signature: 'SIG-1' }, { type: 'text', text: 'Let me look. ' }, { type: 'tool_use', id: 'toolu_01ABC', name: 'read_file', input: { path: 'notes.txt' } }], { stop: 'tool_use', model }))
    if (q.includes('REFUSE')) return res.end(sse([{ type: 'text', text: 'I can' }], { stop: 'refusal', details: { type: 'refusal', category: 'cyber', explanation: 'That could enable cyber harm.' }, model }))
    res.end(sse([{ type: 'thinking', text: 'Considering a greeting.', signature: 'SIG-0' }, { type: 'text', text: 'Hi from Claude!' }], { model, usage: { cache_read_input_tokens: 20 } }))
  })
})
// second fake: an OpenAI-compatible server on the default 9router port, to test provider switching mid-conversation
const openai = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => {
    if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"oa-model"}]}') }
    const b = JSON.parse(raw); openaiReqs.push(b)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'openai says hi' } }] }) + '\n\ndata: [DONE]\n\n'); res.end()
  })
})

const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
const settle = (ms = 350) => new Promise(r => setTimeout(r, ms))
;(async () => {
  await new Promise(r => claude.listen(0, '127.0.0.1', r)); await new Promise(r => openai.listen(20128, '127.0.0.1', r))
  const port = claude.address().port
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria8-')); const ud = path.join(root, 'ud'), ws = path.join(root, 'proj'); fs.mkdirSync(ud); fs.mkdirSync(ws)
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'alpha beta gamma delta\n')
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, theme: 'dark', temperature: 0.7,
    providers: [{ id: 'default', kind: 'openai', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'oa-model' },
      { id: 'claude', kind: 'anthropic', name: 'Claude (fake)', baseUrl: `http://127.0.0.1:${port}`, defaultModel: 'claude-opus-5-5', apiKey: { encrypted: false, value: 'sk-ant-e2e' }, options: { effort: 'high', showThinking: true, promptCaching: true, refusalFallback: true } }],
    activeProviderId: 'claude', tools: { enabled: true, workspace: ws, policies: {} } }))
  const launch = () => electron.launch({ executablePath: BIN || ELECTRON, args: [...(BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  let app = await launch(); let win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 }); win.on('dialog', d => d.accept())
  const idle = () => win.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 20000 })
  const ask = async (q, fresh = true) => { if (fresh) await win.keyboard.press('Control+n'); await win.fill('.composer textarea', q); await win.keyboard.press('Enter') }
  const lastClaude = () => claudeReqs.at(-1).body

  // ---- 1. settings UI
  await win.keyboard.press('Control+,'); await win.waitForSelector('.providers')
  check(await win.$('.provider-list button:has-text("Claude (fake)") small.kind') !== null, 'Claude provider is badged in the list')
  await win.click('.provider-list button:has-text("Claude (fake)")')
  check(await win.inputValue('.provider-form select >> nth=0') === 'anthropic' && await win.inputValue('.claude-opts select') === 'high', 'form shows type=Claude and the saved effort')
  check((await win.textContent('.claude-opts')).includes('temperature setting isn’t sent'), 'UI explains temperature is not sent to Claude')
  await win.click('button:has-text("Test connection")'); await win.waitForSelector('.status.ok')
  check((await win.textContent('.status.ok')).includes('3 models'), 'Test connection works against the Messages API (models.list)')
  await win.screenshot({ path: path.join(SHOTS, '35-claude-provider.png') })
  // add-Claude preset
  await win.click('button:has-text("Add Claude")'); await win.waitForSelector('.provider-list button:nth-of-type(3) small.kind')
  check(await win.inputValue('.provider-form input >> nth=0') === 'Claude (Anthropic)' && (await win.inputValue('.provider-form input >> nth=1')) === 'https://api.anthropic.com', 'Add Claude preset fills name + official API URL')
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).providers.at(-1)
  check(saved.kind === 'anthropic' && saved.defaultModel === 'claude-opus-5-5' && saved.options.promptCaching === true, 'preset saved with kind, default model claude-opus-5-5 and default options')
  await win.click('.provider-list button:nth-of-type(3)'); await win.click('button:has-text("Remove")'); await settle(300)
  await win.keyboard.press('Escape')

  // ---- 2. chat: streaming + reasoning + usage + request shape
  await ask('hello', false)
  await win.waitForSelector('.reasoning'); await idle()
  check((await win.textContent('.reasoning-body')).includes('Considering a greeting.'), 'reasoning summary is shown')
  check((await win.textContent('.msg-assistant .md')) === 'Hi from Claude!', 'answer streamed')
  await win.hover('.msg-assistant')
  check((await win.textContent('.usage')).includes('25 in') && (await win.textContent('.usage')).includes('42 out') && (await win.textContent('.usage')).includes('20 cached'), 'usage line shows tokens in/out/cached')
  const r1 = claudeReqs[0]
  check(r1.headers.authorization === 'Bearer sk-ant-e2e', 'API key sent from the main process')
  check(!('temperature' in r1.body) && r1.body.stream === true && r1.body.max_tokens === 64000, 'no temperature; streaming; max_tokens capped from Models API (64000)')
  check(r1.body.thinking?.type === 'adaptive' && r1.body.thinking.display === 'summarized' && r1.body.output_config?.effort === 'high' && r1.body.cache_control?.type === 'ephemeral', 'adaptive thinking summary, effort=high and prompt caching requested')
  check(typeof r1.body.system === 'string' && r1.body.system.includes('helpful assistant') && Array.isArray(r1.body.tools) && r1.body.tools.some(t => t.name === 'read_file' && t.input_schema?.type === 'object'), 'system prompt + tools (input_schema) sent')
  await win.screenshot({ path: path.join(SHOTS, '36-claude-chat.png') })
  const exposed = await win.evaluate(async () => JSON.stringify(await window.api.settings.get()))
  check(!exposed.includes('sk-ant-e2e'), 'API key never reaches the renderer')

  // ---- 3. tool loop with verbatim thinking replay
  await ask('T1'); await idle()
  check(await win.$('.tool-done') !== null && (await win.textContent('.msg-assistant:last-child .md, .thread .msg-assistant:last-of-type .md')).includes('The file says: alpha beta'), 'tool call ran (read inside workspace) and Claude answered from the result')
  const toolReq = claudeReqs.at(-1).body
  const asst = toolReq.messages.find(m => m.role === 'assistant')
  check(asst.content[0].type === 'thinking' && asst.content[0].signature === 'SIG-1' && asst.content[0].thinking === 'I should read notes.txt.', 'assistant turn replayed VERBATIM incl. thinking block + signature')
  check(asst.content.some(b => b.type === 'tool_use' && b.id === 'toolu_01ABC') && toolReq.messages.at(-1).role === 'user' && toolReq.messages.at(-1).content[0].type === 'tool_result' && toolReq.messages.at(-1).content[0].tool_use_id === 'toolu_01ABC', 'tool_result sent in ONE user message right after the tool_use')
  await win.fill('.composer textarea', 'thanks, anything else?'); await win.keyboard.press('Enter'); await idle()
  const follow = lastClaude().messages
  check(follow.map(m => m.role).join() === 'user,assistant,user,assistant,user', 'follow-up history alternates correctly: ' + follow.map(m => m.role).join())
  check(follow[1].content[0].signature === 'SIG-1', 'thinking signature still intact on the next turn')

  // ---- 4. refusal, auth error, stop
  await ask('REFUSE please'); await win.waitForSelector('.msg-error'); await idle()
  check((await win.textContent('.msg-error')).includes('Claude declined to answer (category: cyber)'), 'refusal shown clearly with its category')
  await win.fill('.composer textarea', 'ok never mind'); await win.keyboard.press('Enter'); await idle()
  const afterRefusal = lastClaude().messages
  check(afterRefusal.length === 1 && JSON.stringify(afterRefusal).includes('REFUSE') && !JSON.stringify(afterRefusal).includes('"I can"') , 'refused turn is not replayed as history (merged user messages): ' + afterRefusal.map(m => m.role).join())
  await ask('ERR401'); await win.waitForSelector('.msg-error'); await idle()
  check((await win.textContent('.msg-error')).includes('Authentication failed (401)'), '401 → "Authentication failed (401)" message')
  await ask('HANG'); await win.waitForFunction(() => document.querySelector('.msg-assistant .md')?.textContent.length > 10); await win.click('.send.stop'); await idle()
  check(await win.$('.msg-error') === null, 'Stop keeps partial Claude text without an error')
  await win.fill('.composer textarea', 'continue'); await win.keyboard.press('Enter'); await idle()
  check(JSON.stringify(lastClaude().messages).includes('Partial answer'), 'partial text is part of the next request’s history')

  // ---- 5. switch provider mid-conversation (Claude history → OpenAI-compatible wire)
  await ask('T1'); await idle()
  await win.click('.picker-btn'); await win.selectOption('.popover-head select', 'default'); await win.waitForSelector('.popover .opt'); await win.click('.popover .opt:has-text("oa-model")')
  await win.fill('.composer textarea', 'now answer via openai'); await win.keyboard.press('Enter'); await idle()
  const oa = openaiReqs.at(-1)
  const wire = oa.messages.map(m => m.role).join()
  check(/user,assistant,tool,assistant,user/.test(wire.replace(/system,/, '')) , 'history converted to OpenAI wire (assistant tool_calls + tool): ' + wire)
  check(!JSON.stringify(oa).includes('SIG-1') && !JSON.stringify(oa).includes('thinking'), 'Claude-specific blocks never leak to another provider')
  check((await win.textContent('.msg-assistant:last-of-type .md')).includes('openai says hi'), 'answer from the OpenAI-compatible provider')

  // ---- 6. persistence
  await settle(500); await app.close(); app = await launch(); win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.conv'); await settle(400)
  await win.click('.conv:has-text("hello")'); await win.waitForSelector('.reasoning')
  check((await win.textContent('.reasoning-body')).includes('Considering') && (await win.$('.usage')) !== null, 'reasoning + usage persist across restart')
  const convs = fs.readdirSync(path.join(ud, 'conversations')).map(f => JSON.parse(fs.readFileSync(path.join(ud, 'conversations', f), 'utf8')))
  check(convs.some(c => c.messages.some(m => m.raw?.[0]?.signature === 'SIG-1')), 'raw provider blocks (with signatures) are stored in the conversation file')
  await app.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
