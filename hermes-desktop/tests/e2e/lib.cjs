// Shared paths for the end-to-end suites (CommonJS, plain Node — run by tests/e2e/run.cjs, not vitest).
const fs = require('fs')
const os = require('os')
const path = require('path')

/** The app directory (hermes-desktop/). Suites launch `electron <APP>`, which runs the built `out/` bundle. */
const APP = path.resolve(__dirname, '..', '..')

/** Electron binary for dev runs. Set TALARIA_BIN to test a packaged (unfused) build instead. */
const ELECTRON = process.env.TALARIA_BIN ? undefined : require(path.join(APP, 'node_modules', 'electron'))

/** Screenshots some suites take along the way (for eyeballing; not compared). */
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'talaria-e2e-shots')
fs.mkdirSync(SHOTS, { recursive: true })

module.exports = { APP, ELECTRON, SHOTS }
