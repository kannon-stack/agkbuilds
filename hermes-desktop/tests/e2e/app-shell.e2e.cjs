const { _electron: electron } = require('playwright-core')
const fs = require('fs'), path = require('path'), os = require('os')
const { APP, ELECTRON, SHOTS } = require('./lib.cjs')
const BIN = process.env.TALARIA_BIN
const check = (c, m) => { console.log(c ? '• ok:' : '✗ FAIL:', m); if (!c) process.exitCode = 1 }
;(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'talaria7-'))
  const app = await electron.launch({ executablePath: BIN || ELECTRON, args: [...(BIN ? [] : [APP]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`] })
  const win = await app.firstWindow(); await win.setViewportSize({ width: 1180, height: 860 }); await win.waitForSelector('.sidebar')
  win.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1 })

  const main = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, name: app.getName(), version: app.getVersion(), resources: process.resourcesPath }))
  check(main.packaged === !!BIN, `app.isPackaged = ${main.packaged} (expected ${!!BIN})`)
  check(main.name === 'Talaria', `app name is "${main.name}"`)
  if (BIN) check(fs.existsSync(path.join(main.resources, 'icon.png')), 'icon.png shipped in resources next to the asar')

  check((await win.textContent('.sidebar kbd')).startsWith('Ctrl'), 'shortcut hints use the platform modifier (Ctrl on Linux)')
  await win.keyboard.press('Control+,'); await win.click('.tabs button:has-text("General")'); await win.waitForSelector('.about')
  const about = await win.textContent('.about')
  check(about.includes('Talaria') && about.includes('0.1.0'), 'About shows name and version')
  check(/Electron \d+\.\d+/.test(about) && /Chromium \d+/.test(about) && /linux x64/.test(about), 'About shows Electron/Chromium/platform')
  check(BIN ? !about.includes('dev build') : about.includes('dev build'), 'dev-build badge only appears when not packaged')
  const dataDir = await win.textContent('.about code')
  check(dataDir === ud, `data folder shown is the real user-data dir (${dataDir})`)
  check(await win.$('button:has-text("Open data folder")') !== null && await win.$('button:has-text("Copy diagnostics")') !== null, 'data-folder and diagnostics actions present')
  await win.click('button:has-text("Copy diagnostics")')
  await new Promise(r => setTimeout(r, 200))
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(clip.includes('Talaria 0.1.0') && clip.includes('Electron') && clip.includes(ud), 'diagnostics text copied to the clipboard')
  await win.screenshot({ path: path.join(SHOTS, BIN ? '33-about-packaged.png' : '33-about-dev.png') })

  // first-run files appear in the data dir
  await win.click('.tabs button:has-text("Appearance")'); await win.click('.segmented button:has-text("Dark")'); await new Promise(r => setTimeout(r, 600))
  check(fs.existsSync(path.join(ud, 'settings.json')), 'settings.json is written to the data dir')
  await app.close(); process.exit(process.exitCode || 0)
})().catch(e => { console.error('CRASH', e); process.exit(1) })
