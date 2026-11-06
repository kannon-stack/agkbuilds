const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const bodies = []

const sse = (res, deltas) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let i = 0
  const t = setInterval(() => { if (i >= deltas.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + '\n\n') }, 4); res.on('close', () => clearInterval(t)) }
const toolCall = (res, name, args) => { const a = JSON.stringify(args)
  sse(res, [{ tool_calls: [{ index: 0, id: 'c' + Date.now() + Math.random().toString(36).slice(2, 5), function: { name, arguments: '' } }] }, ...a.match(/.{1,11}/gs).map(s => ({ tool_calls: [{ index: 0, function: { arguments: s } }] }))]) }
const text = (res, t) => sse(res, t.match(/.{1,7}/gs).map(content => ({ content })))
const sys = (b) => b.messages[0].content
const lastUser = (b) => [...b.messages].reverse().find(m => m.role === 'user').content

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"m"}]}') }
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => { const b = JSON.parse(raw); bodies.push(b); const last = b.messages.at(-1)
    if (last.role === 'user') {
      const q = last.content
      if (q === 'M-REMEMBER') return toolCall(res, 'remember', { text: 'User prefers dark roast coffee' })
      if (q === 'M-SECRET') return toolCall(res, 'remember', { text: 'my password is hunter2hunter2' })
      if (q === 'M-PROJECT') return toolCall(res, 'remember', { text: 'Project uses pnpm', scope: 'project' })
      if (q === 'M-FORGET') { const id = /\[([a-z0-9]{6})\][^\n]*coffee/.exec(sys(b))?.[1] ?? 'zzzzzz'; return toolCall(res, 'forget', { id }) }
      if (q === 'M-USESKILL') return toolCall(res, 'use_skill', { name: 'release-notes' })
      if (q === 'M-READFILE') return toolCall(res, 'read_skill_file', { name: 'release-notes', path: 'templates/format.md' })
      if (q === 'M-ESCAPE') return toolCall(res, 'read_skill_file', { name: 'release-notes', path: '../../settings.json' })
      if (q === 'M-CREATE') return toolCall(res, 'create_skill', { name: 'standup', description: 'Use for writing daily standup notes', instructions: '1. List what was done yesterday\n2. List plans for today\n3. List blockers' })
      if (q === 'M-CREATEBAD') return toolCall(res, 'create_skill', { name: 'Bad Name', description: 'd', instructions: 'x' })
      return text(res, 'plain reply')
    }
    if (last.role === 'tool') return text(res, 'Result: ' + String(last.content).slice(0, 70).replace(/\n/g, ' '))
    text(res, 'ok') })
})
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms))

;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria6-')); const ud = path.join(root, 'ud'); const ws = path.join(root, 'proj')
  fs.mkdirSync(ud); fs.mkdirSync(ws)
  const skill = (base, folder, desc, body, files = {}) => { const d = path.join(base, folder); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${desc}\n---\n\n${body}\n`); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) } return d }
  skill(path.join(ud, 'skills'), 'release-notes', 'Use when writing release notes from a list of changes', '1. Group changes by type\n2. Write user-facing sentences', { 'templates/format.md': '# Release {{version}}\n- item' })
  const wsSkillDir = skill(path.join(ws, '.talaria', 'skills'), 'ws-skill', 'Project specific helper', 'WS INSTRUCTIONS v1')
  const outsideSkill = skill(path.join(root, 'downloaded'), 'imported-skill', 'Imported via the UI', 'Imported body', { 'scripts/run.sh': 'echo hi' })
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, theme: 'dark', providers: [{ id: 'default', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'm' }], activeProviderId: 'default', tools: { enabled: true, workspace: ws, policies: {} } }))

  const launch = () => electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  let app = await launch(); let win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  win.on('dialog', d => d.accept())
  const idle = () => win.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 20000 })
  const ask = async (q, fresh = true) => { if (fresh) await win.keyboard.press('Control+n'); await win.fill('.composer textarea', q); await win.keyboard.press('Enter') }
  const openTab = async (name) => { await win.keyboard.press('Control+,'); await win.click(`.tabs button:has-text("${name}")`) }
  const closeSettings = () => win.keyboard.press('Escape')
  const toolNames = (b) => (b.tools ?? []).map(t => t.function.name)
  const memFile = () => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'memory.json'), 'utf8')).items } catch { return [] } }
  const chip = (emoji) => win.textContent(`.chip:has-text("${emoji}")`).catch(() => null)

  // ---- 1. baseline prompt + chips
  await settle(500)
  check((await chip('⚡'))?.includes('1'), 'skills chip counts only usable skills (untrusted project skill excluded)')
  check((await chip('🧠'))?.includes('0'), 'memory chip starts at 0')
  await ask('hello', false); await idle()
  let b = bodies.at(-1)
  check(sys(b).includes('## Skills') && sys(b).includes('- release-notes: Use when writing release notes') && !sys(b).includes('ws-skill'), 'prompt lists enabled skills, hides the untrusted project skill')
  check(sys(b).includes('## Memory') && sys(b).includes('(no notes yet)') && sys(b).includes('remember tool'), 'prompt invites memory writes when the model can remember')
  check(['remember', 'forget', 'use_skill', 'read_skill_file', 'create_skill'].every(n => toolNames(b).includes(n)), 'model is offered all five memory/skill tools')

  // ---- 2. memory via UI
  await openTab('Memory'); await win.waitForSelector('.mem-add')
  await win.fill('.mem-add input', 'I live in Lisbon'); await win.click('.mem-add button:has-text("Add")'); await win.waitForSelector('.mem-list li')
  await win.screenshot({ path: path.join(SHOTS, '25-memory-tab.png') })
  await win.fill('.mem-add input', 'password is abc12345678'); await win.click('.mem-add button:has-text("Add")')
  check(await win.waitForSelector('.status.bad:has-text("credential")', { timeout: 3000 }).then(() => true, () => false), 'UI refuses to store a secret-looking note')
  await win.fill('.mem-add input', 'i live in LISBON!'); await win.click('.mem-add button:has-text("Add")'); await settle(200)
  check(await win.$$eval('.mem-list li', e => e.length) === 1, 'duplicate (case/punctuation) not stored twice')
  await closeSettings(); await settle(200)
  check((await chip('🧠')).includes('1'), 'memory chip updates to 1')
  await ask('hello again'); await idle()
  check(/- \[[a-z0-9]{6}\] I live in Lisbon/.test(sys(bodies.at(-1))), 'saved note is injected into the next chat\'s system prompt with its id')
  // disable → gone from prompt; edit; delete
  await openTab('Memory'); await win.uncheck('.mem-list li input[type=checkbox]'); await settle(250); await closeSettings()
  await ask('after disable'); await idle()
  check(!sys(bodies.at(-1)).includes('Lisbon') && (await chip('🧠')).includes('0'), 'disabled note is not sent; chip drops to 0')
  await openTab('Memory'); await win.check('.mem-list li input[type=checkbox]')
  await win.click('.mem-text'); await win.fill('.mem-body textarea', 'I live in Porto'); await win.keyboard.press('Enter'); await settle(250)
  check((await win.textContent('.mem-text')) === 'I live in Porto', 'inline edit saves')
  await win.click('.mem-list li button[aria-label="Delete note"]'); await settle(250)
  check(memFile().length === 0, 'delete removes it from disk'); await closeSettings()

  // ---- 3. /remember
  const before = bodies.length
  await win.fill('.composer textarea', '/remember I like jazz'); await win.keyboard.press('Enter'); await settle(400)
  check(bodies.length === before && memFile().some(i => i.text === 'I like jazz' && i.source === 'user'), '/remember saves instantly without calling the model')
  check(await win.$('.toast:has-text("Remembered")') !== null, '/remember confirms with a toast')

  // ---- 4. model saves memory (approval required)
  await ask('M-REMEMBER'); await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-pre')).includes('dark roast coffee') && await win.$('.tool-notice:has-text("Memory persists")') !== null, 'remember approval card shows the exact text + persistence notice')
  check(!memFile().some(i => i.text.includes('coffee')), 'NOTHING is saved before approval')
  await win.screenshot({ path: path.join(SHOTS, '26-remember-approval.png') })
  await win.click('button:has-text("Allow once")'); await idle()
  check(memFile().some(i => i.text === 'User prefers dark roast coffee' && i.source === 'model'), 'saved after approval, tagged as model-created')
  await settle(300)
  check((await chip('🧠')).includes('2'), 'chip live-updates when the MODEL saves a note (data:changed)')
  // secrets never reach an approval prompt
  await ask('M-SECRET'); await idle()
  check(await win.$('.tool-awaiting_approval') === null && (await win.textContent('.tool-error')).length > 0 && !memFile().some(i => i.text.includes('hunter2')), 'model saving a secret: refused up-front, no prompt, nothing stored')
  // project scope
  await ask('M-PROJECT'); await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-label')).includes('this project only'), 'project-scope approval says so')
  await win.click('button:has-text("Allow once")'); await idle()
  check(memFile().some(i => i.text === 'Project uses pnpm' && i.workspace === ws), 'project note is bound to the workspace folder')
  // forget shows the note text
  await ask('M-FORGET'); await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-pre.del')).includes('dark roast coffee'), 'forget approval card shows the note being deleted')
  await win.click('.tool-approve button:has-text("Allow once")'); await idle()
  check(!memFile().some(i => i.text.includes('coffee')), 'forgotten after approval')

  // memory master switch
  await openTab('Memory'); await win.uncheck('.switch input'); await settle(300); await closeSettings()
  await ask('memory off'); await idle(); b = bodies.at(-1)
  check(!sys(b).includes('## Memory') && !toolNames(b).includes('remember') && !toolNames(b).includes('forget') && await win.$('.chip:has-text("🧠")') === null, 'memory off: no prompt section, no tools, no chip')
  await openTab('Memory'); await win.check('.switch input'); await settle(300); await closeSettings()

  // ---- 5. skills: model use_skill / read_skill_file / escape
  await ask('M-USESKILL'); await idle()
  check(await win.$('.tool-awaiting_approval') === null, 'use_skill runs without asking (read-only)')
  const toolMsg = bodies.at(-1).messages.filter(m => m.role === 'tool').at(-1).content
  check(toolMsg.includes('# Skill: release-notes') && toolMsg.includes('1. Group changes by type') && toolMsg.includes('templates/format.md'), 'model receives the skill instructions + bundled file list')
  await ask('M-READFILE'); await idle()
  check(bodies.at(-1).messages.filter(m => m.role === 'tool').at(-1).content.includes('# Release {{version}}'), 'read_skill_file returns bundled file content')
  await ask('M-ESCAPE'); await idle()
  check(bodies.at(-1).messages.filter(m => m.role === 'tool').at(-1).content.includes('outside the "release-notes" skill folder'), 'read_skill_file cannot escape the skill folder (../../settings.json)')

  // ---- 6. slash menu + invocation
  await win.keyboard.press('Control+n'); await win.fill('.composer textarea', '/rel'); await win.waitForSelector('.slash-menu')
  await win.screenshot({ path: path.join(SHOTS, '27-slash-menu.png') })
  check((await win.textContent('.slash-menu')).includes('release-notes') && !(await win.textContent('.slash-menu')).includes('remember'), 'slash menu filters by prefix')
  await win.keyboard.press('Tab')
  check(await win.inputValue('.composer textarea') === '/release-notes ', 'Tab completes the command')
  await win.keyboard.type('v1.2 fixed bugs and added dark mode'); await win.keyboard.press('Enter'); await idle()
  b = bodies.at(-1)
  check(await win.$('.skill-chip:has-text("release-notes")') !== null, 'user message shows a ⚡ skill chip')
  check(lastUser(b).includes('invoked the skill "release-notes"') && lastUser(b).includes('1. Group changes by type') && lastUser(b).endsWith('v1.2 fixed bugs and added dark mode') && !lastUser(b).includes('/release-notes v1.2'), '/skill injects instructions + only the args reach the model')
  await win.fill('.composer textarea', '/'); check(await win.$$eval('.slash-item', e => e.length) >= 2, 'bare "/" lists all commands')
  await win.keyboard.press('Escape'); check(await win.$('.slash-menu') === null, 'Escape closes the menu'); await win.fill('.composer textarea', '')
  await ask('/not-a-skill hello'); await idle()
  check(lastUser(bodies.at(-1)) === '/not-a-skill hello' && await win.$$eval('.skill-chip', e => e.length) === 0, 'unknown /command is sent as plain text')

  // ---- 7. model creates a skill (approval) / invalid is refused up-front
  await ask('M-CREATEBAD'); await idle()
  check(await win.$('.tool-awaiting_approval') === null && (await win.textContent('.tool-error')).length > 0 && !fs.existsSync(path.join(ud, 'skills', 'Bad Name')), 'invalid skill name refused before any prompt')
  await ask('M-CREATE'); await win.waitForSelector('.tool-awaiting_approval')
  check((await win.textContent('.tool-body')).includes('3. List blockers') && await win.$('.tool-notice:has-text("skills folder")') !== null, 'create_skill approval shows the full instructions')
  check(!fs.existsSync(path.join(ud, 'skills', 'standup')), 'nothing written before approval')
  await win.screenshot({ path: path.join(SHOTS, '28-create-skill-approval.png') })
  await win.click('button:has-text("Allow once")'); await idle(); await settle(300)
  const sm = fs.readFileSync(path.join(ud, 'skills', 'standup', 'SKILL.md'), 'utf8')
  check(sm.includes('name: standup') && sm.includes('talaria-model') && sm.includes('3. List blockers'), 'skill saved as SKILL.md, tagged as model-created')
  check((await chip('⚡')).includes('2'), 'skills chip live-updates after the model creates one')
  await ask('after create'); await idle()
  check(sys(bodies.at(-1)).includes('- standup: Use for writing daily standup notes'), 'new skill appears in the next request\'s catalog')

  // ---- 8. Skills tab: states, workspace trust
  await openTab('Skills'); await win.waitForSelector('.skill')
  await win.screenshot({ path: path.join(SHOTS, '29-skills-tab.png') })
  const cards = await win.$$eval('.skill', els => els.map(e => ({ name: e.querySelector('.skill-name').textContent, txt: e.textContent, on: e.querySelector('input[type=checkbox]')?.checked })))
  check(cards.find(c => c.name === '/standup').txt.includes('created by AI') && cards.find(c => c.name === '/release-notes').txt.includes('yours'), 'source badges (yours / created by AI)')
  const ws1 = cards.find(c => c.name === '/ws-skill')
  check(ws1 && ws1.txt.includes('not enabled') && ws1.on === false, 'project skill is OFF and explains why')
  await win.click('.skill:has(.skill-name:text-is("/ws-skill")) button:has-text("View instructions")'); await win.waitForSelector('.skill-body')
  check((await win.textContent('.skill-body')).includes('WS INSTRUCTIONS v1'), 'you can review a project skill\'s instructions before enabling')
  await win.check('.skill:has(.skill-name:text-is("/ws-skill")) input[type=checkbox]'); await settle(400)
  await closeSettings(); await ask('after ws enable'); await idle()
  check(sys(bodies.at(-1)).includes('- ws-skill: Project specific helper'), 'approved project skill joins the catalog')
  // the repo changes it → approval revoked
  fs.writeFileSync(path.join(wsSkillDir, 'SKILL.md'), '---\nname: ws-skill\ndescription: Project specific helper\n---\n\nWS INSTRUCTIONS v2 (changed!)\n')
  await ask('after ws change'); await idle()
  check(!sys(bodies.at(-1)).includes('ws-skill'), 'changed project skill is automatically dropped from the prompt (trust is bound to content)')
  await openTab('Skills'); await win.click('button:has-text("Refresh")'); await settle(300)
  check((await win.textContent('.skill:has(.skill-name:text-is("/ws-skill"))')).includes('changed since you enabled'), 'UI says the skill changed and needs re-approval')
  await win.screenshot({ path: path.join(SHOTS, '30-skill-changed.png') })

  // ---- 9. skill editor + import + delete
  await win.click('button:has-text("New skill")')
  await win.fill('input[placeholder="code-review"]', 'My Skill'); await win.fill('.modal textarea >> nth=0', 'Does X when Y'); await win.click('button:has-text("Save skill")')
  check(await win.$('.status.bad:has-text("Name must")') !== null, 'editor validates the name')
  await win.fill('input[placeholder="code-review"]', 'my-skill'); await win.click('button:has-text("Save skill")'); await win.waitForSelector('.skill:has(.skill-name:text-is("/my-skill"))')
  check(fs.existsSync(path.join(ud, 'skills', 'my-skill', 'SKILL.md')), 'new skill saved from the UI')
  await win.click('.skill:has(.skill-name:text-is("/my-skill")) button:has-text("Edit")'); await win.fill('input[placeholder="code-review"]', 'renamed-skill'); await win.click('button:has-text("Save skill")')
  await win.waitForSelector('.skill:has(.skill-name:text-is("/renamed-skill"))')
  check(!fs.existsSync(path.join(ud, 'skills', 'my-skill')) && fs.existsSync(path.join(ud, 'skills', 'renamed-skill')), 'rename moves the folder')
  await win.click('.skill:has(.skill-name:text-is("/renamed-skill")) button:has-text("Delete")'); await settle(300)
  check(!fs.existsSync(path.join(ud, 'skills', 'renamed-skill')), 'delete removes the folder')
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, outsideSkill)
  await win.click('button:has-text("Import folder")'); await win.waitForSelector('.skill:has(.skill-name:text-is("/imported-skill"))')
  check(fs.existsSync(path.join(ud, 'skills', 'imported-skill', 'scripts', 'run.sh')), 'import copies the folder incl. bundled files')
  await win.click('button:has-text("Import folder")'); await settle(300)
  check(await win.$('.toast:has-text("already exists")') !== null, 'importing a duplicate is refused with a clear message')

  // ---- 10. skills master switch
  await win.uncheck('.switch input'); await settle(300); await closeSettings()
  check(await win.$('.chip:has-text("⚡")') === null, 'skills off: chip hidden')
  await ask('/release-notes v9'); await idle(); b = bodies.at(-1)
  check(!sys(b).includes('## Skills') && !toolNames(b).includes('use_skill') && !toolNames(b).includes('create_skill') && lastUser(b) === '/release-notes v9' && await win.$$eval('.skill-chip', e => e.length) === 0, 'skills off: no catalog, no tools, /name is plain text')
  await openTab('Skills'); await win.check('.switch input'); await settle(300); await closeSettings()

  // ---- 11. persistence + hostile settings
  await app.close(); app = await launch(); win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar'); await settle(600)
  check((await chip('⚡'))?.includes('3') && (await chip('🧠'))?.includes('2'), 'memory + skills persist across restart (chips: ' + (await chip('⚡')) + ' ' + (await chip('🧠')) + ')')
  await app.close()
  const cur = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'))
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, ...cur, skills: { enabled: 'yes', disabled: 'nope', trusted: { a: 5, b: { x: 1 } } }, memory: 'weird' }))
  app = await launch(); win = await app.firstWindow(); await win.waitForSelector('.sidebar'); await settle(400)
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  check(await win.$('.composer') !== null, 'hand-edited/garbage skills & memory settings do not break startup')
  await app.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
