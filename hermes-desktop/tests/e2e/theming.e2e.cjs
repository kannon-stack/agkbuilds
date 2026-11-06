const { _electron: electron } = require('playwright-core')
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const REPLY = "Here is some code:\n\n```python\ndef greet(name):\n    return f\"Hello, {name}!\"  # say hi\n```\n\nAnd a [link](https://example.com) plus `inline code` and **bold**."
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200); return res.end('{"data":[{"id":"m"}]}') }
  let raw = ''; req.on('data', c => raw += c)
  req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const c of REPLY.match(/.{1,8}/gs)) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n')
    res.end('data: [DONE]\n\n') })
})
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria5-'))
const launch = (ud) => electron.launch({ executablePath: process.env.TALARIA_BIN || ELECTRON, args: [...(process.env.TALARIA_BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
const cssVar = (win, v) => win.evaluate((v) => document.documentElement.style.getPropertyValue(v).trim(), v)
const winBg = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())
const settle = (ms = 350) => new Promise(r => setTimeout(r, ms))   // debounce (250ms) + IPC

;(async () => {
  await new Promise(r => server.listen(20128, '127.0.0.1', r))
  const ud = path.join(root, 'ud'); fs.mkdirSync(ud)
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ titles: { enabled: false }, providers: [{ id: 'default', name: '9router (local)', baseUrl: 'http://localhost:20128/v1', defaultModel: 'm' }], activeProviderId: 'default' }))
  let app = await launch(ud); let win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  win.on('console', m => m.type() === 'error' && console.error('CONSOLE', m.text()))

  // ---- 1. default + system mode + native bg + reveal
  await win.emulateMedia({ colorScheme: 'light' }); await settle(100)
  check(await win.evaluate(() => document.documentElement.dataset.theme) === 'light' && await cssVar(win, '--bg') === '#fbfaf8', 'system(light OS) → Talaria Light applied')
  check(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'window revealed after theme applied')
  await win.emulateMedia({ colorScheme: 'dark' }); await settle(150)
  check(await cssVar(win, '--bg') === '#0e1014' && await win.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'OS flips to dark → app follows live (Talaria Dark)')
  await win.emulateMedia({ colorScheme: 'light' }); await settle(100)

  // ---- 2. appearance tab: mode + picking themes
  await win.fill('.composer textarea', 'hi'); await win.keyboard.press('Enter'); await win.waitForSelector('.codeblock'); await win.waitForFunction(() => !document.querySelector('.send.stop'))
  await win.keyboard.press('Control+,'); await win.click('.tabs button:has-text("Appearance")'); await win.waitForSelector('.theme-grid')
  await win.screenshot({ path: path.join(SHOTS, '17-appearance-light.png') })
  check(await win.$$eval('.theme-card', e => e.length) === 11, 'gallery shows all 11 built-in themes')
  await win.click('.segmented button:has-text("Dark")'); await settle(100)
  check(await cssVar(win, '--bg') === '#0e1014', 'Mode=Dark overrides light OS')
  await win.click('.theme-card[aria-label^="Midnight"]'); await settle(100)
  check(await cssVar(win, '--bg') === '#0a0f1e' && await cssVar(win, '--accent') === '#5aa2ff', 'picking Midnight re-themes instantly')
  await settle(500)
  check(await winBg(app) === '#0a0f1e', 'native window background follows theme (' + await winBg(app) + ')')
  await win.screenshot({ path: path.join(SHOTS, '18-appearance-midnight.png') })
  // picking a light theme while in dark mode switches mode so you can see it
  await win.click('.theme-card[aria-label^="Paper"]'); await settle(150)
  check(await cssVar(win, '--bg') === '#f7f1e3' && await win.evaluate(() => document.documentElement.dataset.theme) === 'light', 'picking a light theme in dark mode switches mode (so the change is visible)')
  check(await win.$('.toast') !== null, 'user is told about the mode switch')

  // ---- 3. every preset applies (and nothing throws)
  for (const [name, bg] of [['Talaria Dark', '#0e1014'], ['Midnight', '#0a0f1e'], ['Forest', '#0d1411'], ['Dusk', '#120f1a'], ['Graphite', '#121212'], ['High Contrast Dark', '#000000'],
    ['Talaria Light', '#fbfaf8'], ['Paper', '#f7f1e3'], ['Sky', '#f6f9fd'], ['Mint', '#f4faf6'], ['High Contrast Light', '#ffffff']]) {
    await win.click(`.theme-card[aria-label^="${name}"]`); await settle(60)
    if (await cssVar(win, '--bg') !== bg) check(false, `preset ${name} applies (${await cssVar(win, '--bg')} ≠ ${bg})`)
    if (name === 'Dusk') await win.screenshot({ path: path.join(SHOTS, '19-dusk.png') })
  }
  check(true, 'all 11 presets applied via the UI')

  // ---- 4. accent override
  await win.click('.theme-card[aria-label^="Talaria Dark"]'); await settle(100)
  await win.click('.swatch[aria-label="Accent #ff9a62"]'); await settle(100)
  check(await cssVar(win, '--accent') === '#ff9a62' && await cssVar(win, '--accent-ink') === '#101010', 'accent override applies, ink auto-picked for contrast')
  await win.click('.swatch[aria-label="Accent #5aa2ff"]'); await settle(100)
  check(await cssVar(win, '--accent-ink') === '#101010', 'ink recomputed for second accent')
  await win.click('.swatch[aria-label="Theme default accent"]'); await settle(100)
  check(await cssVar(win, '--accent') === '#e2b65c', 'reset accent → theme default')

  // ---- 5. typography / layout
  await win.evaluate(() => { const r = document.querySelector('input[aria-label="Text size"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '1.2'); r.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(100)
  const sizes = await win.evaluate(() => ({ body: getComputedStyle(document.body).fontSize, brand: getComputedStyle(document.querySelector('.brand')).fontSize, code: getComputedStyle(document.querySelector('.codeblock pre')).fontSize }))
  check(sizes.body === '17.4px' && sizes.brand === '18px' && sizes.code === '15.6px', `text size 120% scales body/sidebar/code (${JSON.stringify(sizes)})`)
  await win.click('.segmented button:has-text("Sharp")'); await win.click('.segmented button:has-text("Narrow")'); await settle(100)
  check(await cssVar(win, '--radius') === '4px' && await cssVar(win, '--thread-w') === '640px', 'roundness + chat width apply')
  check(await win.evaluate(() => document.querySelector('.thread').getBoundingClientRect().width <= 640.5), 'narrow chat width actually constrains the thread')
  await win.selectOption('.two-col select >> nth=0', 'serif'); await settle(100)
  check((await cssVar(win, '--font-ui')).includes('Georgia'), 'serif UI font stack')
  await win.selectOption('.two-col select >> nth=0', 'custom')
  await win.fill('input[placeholder^="e.g. Inter"]', 'x; } body { display:none } /* Fira Sans'); await win.keyboard.press('Enter'); await settle(100)
  const fu = await cssVar(win, '--font-ui')
  check(!/[;{}]/.test(fu) && await win.evaluate(() => getComputedStyle(document.body).display) !== 'none', `custom font input can't inject CSS (→ "${fu.slice(0, 40)}…")`)
  await win.selectOption('.two-col select >> nth=0', 'system'); await settle(100)

  // ---- 6. editor: live preview, cancel, save
  await win.click('.theme-card[aria-label^="Forest"]'); await settle(100)
  await win.click('.theme-item:has(.theme-card[aria-label^="Forest"]) button:has-text("Customize")')
  await win.waitForSelector('.color-grid')
  await win.fill('.color-row:has-text("Accent") >> nth=0 >> .hex', '#ff00aa'); await settle(100)
  check(await cssVar(win, '--accent') === '#ff00aa', 'editor edits preview live across the whole app')
  await win.fill('.color-row:has-text("Muted text") .hex', '#222222'); await settle(100)
  check((await win.textContent('.checks')).includes('Muted text on background') && await win.$('.pill.bad') !== null, 'low-contrast edit is flagged in the readability panel')
  await win.screenshot({ path: path.join(SHOTS, '20-editor.png') })
  await win.click('button:has-text("Cancel")'); await settle(100)
  check(await cssVar(win, '--accent') === '#6fd3a0', 'Cancel reverts the preview')
  await win.click('.theme-item:has(.theme-card[aria-label^="Forest"]) button:has-text("Customize")'); await win.waitForSelector('.color-grid')
  await win.fill('input[maxlength="40"]', 'Hot Forest'); await win.fill('.color-row:has-text("Accent") >> nth=0 >> .hex', '#ff00aa')
  await win.fill('.color-row:has-text("Muted text") .hex', 'not-a-color')
  check(await win.$('.hex.invalid') !== null, 'invalid hex flagged, previous value kept')
  await win.click('button:has-text("Save theme")'); await settle(500)
  check(await win.$('.theme-card[aria-label^="Hot Forest (selected)"]') !== null && await cssVar(win, '--accent') === '#ff00aa', 'saved custom theme appears in gallery, selected & applied')

  // ---- 7. export / import / delete
  await win.click('.theme-item:has(.theme-card[aria-label^="Hot Forest"]) button:has-text("Export")'); await settle(150)
  const exported = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(exported.includes('"talariaTheme": 1') && exported.includes('Hot Forest') && exported.includes('#ff00aa'), 'Export puts valid theme JSON on the clipboard')
  await win.click('button:has-text("Import theme")'); await win.fill('.modal textarea', 'garbage'); await win.click('button:has-text("Review theme")')
  check(await win.$('.status.bad:has-text("not valid JSON")') !== null, 'import: invalid JSON → clear error')
  await win.fill('.modal textarea', exported.replace('Hot Forest', 'Imported Pink')); await win.click('button:has-text("Review theme")'); await win.waitForSelector('.color-grid')
  check(await win.inputValue('input[maxlength="40"]') === 'Imported Pink', 'import: opens editor prefilled for review')
  await win.click('button:has-text("Save theme")'); await settle(500)
  check(await win.$$eval('.theme-card', e => e.filter(x => /Hot Forest|Imported Pink/.test(x.getAttribute('aria-label'))).length) === 2, 'imported theme saved alongside original')
  await win.screenshot({ path: path.join(SHOTS, '21-custom-themes.png') })

  // ---- 8. persistence across restart + native bg at creation
  await settle(300); await app.close()
  app = await launch(ud); win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  check(await cssVar(win, '--accent') === '#ff00aa' && await cssVar(win, '--thread-w') === '640px' && await cssVar(win, '--radius') === '4px', 'custom theme, layout & shape persisted across restart')
  check(await winBg(app) === (await cssVar(win, '--bg')), 'window created with the saved theme background (no wrong-colour flash): ' + await winBg(app))
  check(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'window visible after restart')
  await win.keyboard.press('Control+,'); await win.click('.tabs button:has-text("Appearance")'); await win.waitForSelector('.theme-grid')
  // delete the active custom theme → falls back
  win.on('dialog', d => d.accept())
  await win.click('.theme-item:has(.theme-card[aria-label^="Hot Forest"]) button:has-text("Delete")'); await settle(500)
  check(await win.$('.theme-card[aria-label^="Hot Forest"]') === null, 'custom theme deleted')
  check(await cssVar(win, '--bg') !== '' && (await win.$$eval('.theme-item.selected', e => e.length)) === 2, 'deleting a theme never leaves a dangling selection (both slots still have a selected theme)')
  await app.close()

  // ---- 9. hostile / corrupt settings file
  const ud2 = path.join(root, 'ud2'); fs.mkdirSync(ud2)
  fs.writeFileSync(path.join(ud2, 'settings.json'), JSON.stringify({ titles: { enabled: false }, theme: 'dark', appearance: { darkTheme: '__proto__', lightTheme: 5, accent: 'url(javascript:alert(1))', fontScale: 99, radius: 'enormous', chatWidth: null, uiFont: 'custom', uiFontCustom: '}{;', customThemes: [{ id: 'x', name: 5, base: 'dark', colors: { bg: 'expression(alert(1))' } }, 'junk', null] } }))
  app = await launch(ud2); win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })
  check(await cssVar(win, '--bg') === '#0e1014' && await cssVar(win, '--accent') === '#e2b65c' && await cssVar(win, '--font-scale') === '1.35' && await cssVar(win, '--radius') === '10px', 'hostile settings.json → sanitized: defaults restored, font scale clamped, app loads')
  check(!/[;{}]/.test(await cssVar(win, '--font-ui')), 'hostile custom font ignored')
  await app.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
