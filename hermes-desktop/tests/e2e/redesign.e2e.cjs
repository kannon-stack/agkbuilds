// The Glass redesign: title bar, collapsible sidebar, greeting + starter prompts, settings page,
// transparency fallback. Also captures screenshots of every main screen in several themes.
const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const bodies = []

const sse = (res, deltas, gap = 6) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let i = 0
  const t = setInterval(() => {
    if (i >= deltas.length) { clearInterval(t); res.write('data: [DONE]\n\n'); return res.end() }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + '\n\n')
  }, gap)
  res.on('close', () => clearInterval(t))
}
const text = (res, t) => sse(res, t.match(/.{1,24}/gs).map((content) => ({ content })))
const ANSWER = "Your project already uses f-strings and type hints, so I matched that. Here is the function and a test:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name.strip() or 'friend'}!\"\n\ndef test_greet():\n    assert greet(\"Ada\") == \"Hello, Ada!\"\n```\n\nI'll run the test next."

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"cc/claude-opus-4-7"}]}') }
  let raw = ''; req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw); bodies.push(body)
    const last = body.messages.at(-1)
    if (last.role === 'user' && /greets a user/.test(last.content)) {
      const args = JSON.stringify({ command: 'pytest tests/test_greet.py' })
      return sse(res, [
        ...ANSWER.match(/.{1,24}/gs).map((content) => ({ content })),
        { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '' } }] },
        { tool_calls: [{ index: 0, function: { arguments: args } }] }
      ])
    }
    if (last.role === 'tool') return text(res, 'All tests passed.')
    text(res, 'Sure — ' + String(last.content).slice(0, 40))
  })
})

const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
;(async () => {
  await new Promise((r) => server.listen(20128, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria-redesign-'))
  const ws = path.join(root, 'agk'); fs.mkdirSync(ws)
  const userData = path.join(root, 'data'); fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    titles: { enabled: false }, theme: 'dark', tools: { enabled: true, workspace: ws, policies: {} },
    providers: [{ id: 'default', name: '9router (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:20128/v1', defaultModel: 'cc/claude-opus-4-7' }]
  }))
  const launch = async () => {
    const app = await electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`] })
    const win = await app.firstWindow(); await win.setViewportSize({ width: 1240, height: 800 }); await win.waitForSelector('.titlebar')
    win.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
    return { app, win }
  }
  const shot = (win, name) => win.screenshot({ path: path.join(SHOTS, `redesign-${name}.png`) })
  let { app, win } = await launch()

  // Window chrome: frameless with an app-drawn title bar.
  const chrome = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { overlay: typeof w.setTitleBarOverlay === 'function' } })
  check(chrome.overlay, 'window supports the native controls overlay')
  check(await win.$('.titlebar .picker-btn') !== null && await win.$('.titlebar .tb-brand') !== null, 'title bar holds the brand and the model picker')
  const drag = await win.$eval('.titlebar', (e) => getComputedStyle(e).getPropertyValue('-webkit-app-region') || getComputedStyle(e).webkitAppRegion)
  check(/drag/.test(drag), `title bar is a window drag region (${drag})`)
  check(await win.$eval('.titlebar .picker-btn', (e) => getComputedStyle(e).webkitAppRegion) === 'no-drag', 'buttons in the title bar stay clickable (no-drag)')

  // New chat: greeting, centred composer, starters, bundled font.
  check(await win.textContent('.welcome h2').then((t) => /^Good (morning|afternoon|evening)$/.test(t)), 'greeting without a name')
  const font = await win.evaluate(() => getComputedStyle(document.body).fontFamily)
  check(font.startsWith("'Plus Jakarta Sans Variable'") || font.startsWith('"Plus Jakarta Sans Variable"'), 'modern font is the default UI font')
  check(await win.evaluate(() => document.fonts.check('14px "Plus Jakarta Sans Variable"')), 'bundled font is loaded (works offline)')
  const box = await win.$eval('.composer', (e) => e.getBoundingClientRect().top)
  check(box > 250 && box < 520, `composer sits in the middle of an empty chat (top=${Math.round(box)})`)
  check(await win.$$eval('.starter', (e) => e.length) === 5, 'five starter prompts')
  await win.click('.starter:has-text("Draft an email")')
  await win.waitForFunction(() => document.querySelector('.composer textarea').value !== '', null, { timeout: 3000 }).catch(() => {})
  const filled = await win.inputValue('.composer textarea')
  check(filled === 'Draft a short, friendly email to ', `starter fills the composer (${JSON.stringify(filled)})`)
  check(await win.evaluate(() => document.activeElement?.tagName) === 'TEXTAREA', 'composer is focused after a starter')
  check(bodies.length === 0, 'a starter never sends by itself')
  await win.fill('.composer textarea', '')
  await shot(win, '1-new-chat-dark')

  // Name: Settings → General, then the greeting and the sidebar profile use it.
  await win.click('.me-name')
  await win.waitForSelector('.settings-page')
  check(await win.textContent('.settings-head h2') === 'General', 'clicking the profile opens Settings → General')
  check(await win.$('.workspace[hidden]') !== null, 'chat is hidden (kept mounted) while settings are open')
  await win.fill('input[placeholder="Your first name"]', '  Dylan '); await win.keyboard.press('Enter'); await win.waitForTimeout(250)
  check((await win.evaluate(() => window.api.settings.get())).userName === 'Dylan', 'name is saved (trimmed)')
  await shot(win, '2-settings-general-dark')
  await win.click('.tabs button:has-text("Providers")'); await win.waitForSelector('.provider-form')
  await shot(win, '3-settings-providers-dark')
  await win.click('.settings-back')
  check(await win.$('.settings-page') === null && await win.$('.workspace:not([hidden])') !== null, 'Back to chat closes settings')
  check(/, Dylan$/.test(await win.textContent('.welcome h2')), 'greeting uses the name')
  check(await win.textContent('.me-avatar') === 'D' && await win.textContent('.me-name') === 'Dylan', 'sidebar profile shows initial and name')

  // A draft survives a trip to settings (the chat stays mounted).
  await win.fill('.composer textarea', 'half-written thought')
  await win.keyboard.press('Control+,'); await win.waitForSelector('.settings-page'); await win.keyboard.press('Escape')
  await win.waitForSelector('.settings-page', { state: 'detached' })
  check(await win.inputValue('.composer textarea') === 'half-written thought', 'draft survives opening settings')
  await win.fill('.composer textarea', '')

  // Chat with a tool approval.
  await win.fill('.composer textarea', 'Can you write a small function that greets a user by name, and add a test for it?')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.tool-awaiting_approval')
  await win.waitForTimeout(300)
  check(await win.textContent('.chat-head h1') !== 'New chat', 'title bar shows the chat title')
  const cBox = await win.$eval('.composer', (e) => e.getBoundingClientRect().bottom)
  check(cBox > 700, `composer moves to the bottom once the chat has messages (bottom=${Math.round(cBox)})`)
  await shot(win, '4-chat-approval-dark')
  await win.click('.tool-approve button:has-text("Deny")')
  await win.waitForFunction(() => !document.querySelector('.send.stop'))

  // Sidebar collapse: button and Ctrl+B, remembered across restarts.
  await win.click('.titlebar button[aria-label="Hide sidebar"]'); await win.waitForTimeout(300)
  check(await win.$('.app.sidebar-collapsed') !== null, 'title-bar button hides the sidebar')
  check(await win.$eval('.sidebar', (e) => e.getBoundingClientRect().width) < 2, 'sidebar has no width when hidden')
  check(await win.$eval('.sidebar', (e) => e.inert === true), 'hidden sidebar is inert (not tabbable)')
  await shot(win, '5-collapsed-dark')
  await win.keyboard.press('Control+b'); await win.waitForTimeout(300)
  check(await win.$('.app.sidebar-collapsed') === null, 'Ctrl+B shows it again')
  await win.keyboard.press('Control+b'); await win.waitForTimeout(100)
  await app.close(); ({ app, win } = await launch())
  check(await win.$('.app.sidebar-collapsed') !== null, 'collapsed state is remembered after a restart')
  await win.keyboard.press('Control+k'); await win.waitForTimeout(150)
  check(await win.$('.app.sidebar-collapsed') === null && await win.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search chats', 'Ctrl+K opens the sidebar and focuses search')
  await win.keyboard.type('greet'); await win.waitForSelector('.result')
  await shot(win, '6-search-dark')
  await win.keyboard.press('Escape')

  // Transparency: on by default, off by setting, always off for high-contrast themes.
  const glass = () => win.evaluate(() => document.documentElement.dataset.glass)
  const blur = () => win.$eval('.sidebar', (e) => getComputedStyle(e).backdropFilter)
  check(await glass() === 'on' && /blur/.test(await blur()), 'glass is on by default (sidebar is blurred)')
  await win.evaluate(() => window.api.settings.update({ appearance: { glass: false } }).then(() => location.reload()))
  await win.waitForSelector('.titlebar')
  check(await glass() === 'off' && (await blur()) === 'none', 'transparency off: solid sidebar, no blur')
  await win.evaluate(() => window.api.settings.update({ appearance: { glass: true, darkTheme: 'contrast-dark' } }).then(() => location.reload()))
  await win.waitForSelector('.titlebar')
  check(await glass() === 'off', 'high-contrast theme forces solid panels')

  // The same chat across themes, for eyeballing.
  await win.click('.conv >> nth=0'); await win.waitForSelector('.msg-assistant')
  for (const [mode, theme, key] of [['dark', 'talaria-dark', 'darkTheme'], ['dark', 'midnight', 'darkTheme'], ['dark', 'forest', 'darkTheme'], ['dark', 'dusk', 'darkTheme'], ['light', 'talaria-light', 'lightTheme'], ['light', 'sky', 'lightTheme'], ['light', 'mint', 'lightTheme'], ['light', 'paper', 'lightTheme']]) {
    await win.evaluate(([m, t, k]) => window.api.settings.update({ theme: m, appearance: { [k]: t } }).then(() => location.reload()), [mode, theme, key])
    await win.waitForSelector('.msg-assistant'); await win.waitForTimeout(200)
    await shot(win, `7-chat-${theme}`)
  }
  check(await win.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light theme applied')
  await win.click('.titlebar .picker-btn'); await win.waitForSelector('.popover')
  const pop = await win.$eval('.popover', (e) => e.getBoundingClientRect().top)
  check(pop > 30, `model list opens below the title bar (top=${Math.round(pop)})`)
  await shot(win, '8-picker-light')
  await win.keyboard.press('Escape')
  await win.click('button:has-text("New chat")'); await win.waitForSelector('.welcome')
  await shot(win, '9-new-chat-light')

  await app.close(); server.close(); process.exit(process.exitCode || 0)
})().catch((e) => { console.error('CRASH', e); process.exit(1) })
