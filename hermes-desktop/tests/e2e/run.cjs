#!/usr/bin/env node
// End-to-end runner: launches the real Electron app against local fake providers, one suite at a time.
//
//   npm run e2e                       # build, then run every suite
//   node tests/e2e/run.cjs chat mcp   # run only suites whose name contains "chat" or "mcp" (needs a prior `npm run build`)
//   TALARIA_BIN=release/linux-unpacked/talaria node tests/e2e/run.cjs   # test a packaged build (pack with TALARIA_UNFUSED=1)
//
// Linux without a display: wrap in `xvfb-run -a`. The fake providers listen on 127.0.0.1:20128 (the 9router default), so stop
// a local 9router first.
const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const DIR = __dirname
const APP = path.resolve(DIR, '..', '..')
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 240_000
const filters = process.argv.slice(2)

const suites = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.e2e.cjs'))
  .map((f) => f.replace(/\.e2e\.cjs$/, ''))
  .filter((name) => !filters.length || filters.some((x) => name.includes(x)))
  .sort()

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(DIR, `${name}.e2e.cjs`)], { cwd: APP, env: process.env })
    let out = ''
    const onData = (d) => {
      out += d
      if (process.env.E2E_VERBOSE) process.stdout.write(d)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const passed = (out.match(/^• ok:/gm) || []).length
      const failures = out.split('\n').filter((l) => /✗ FAIL|PAGE ERROR|CRASH/.test(l))
      const ok = code === 0 && !failures.length && !timedOut
      resolve({ name, ok, passed, failures, out, timedOut, secs: ((Date.now() - started) / 1000).toFixed(1) })
    })
  })
}

;(async () => {
  if (!suites.length) {
    console.error(`No suites match: ${filters.join(', ')}`)
    process.exit(2)
  }
  if (!process.env.TALARIA_BIN && !fs.existsSync(path.join(APP, 'out', 'main'))) {
    console.error('The app is not built. Run `npm run build` first (or `npm run e2e`, which builds).')
    process.exit(2)
  }
  if (!(await portFree(20128))) {
    console.error('Port 20128 is in use — the suites need it for their fake provider. Stop 9router (or whatever is listening) and retry.')
    process.exit(2)
  }

  const results = []
  for (const name of suites) {
    process.stdout.write(`▶ ${name.padEnd(14)} `)
    const r = await runSuite(name)
    results.push(r)
    console.log(r.ok ? `✓ ${r.passed} checks (${r.secs}s)` : `✗ ${r.timedOut ? 'TIMED OUT' : 'FAILED'} after ${r.passed} passing checks (${r.secs}s)`)
    if (!r.ok) {
      // Show the whole log for a failing suite; it's the only way to see what happened on CI.
      console.log(r.out.replace(/^/gm, '    │ '))
    }
  }

  const failed = results.filter((r) => !r.ok)
  const total = results.reduce((s, r) => s + r.passed, 0)
  console.log(`\n${results.length - failed.length}/${results.length} suites passed · ${total} checks`)
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
})()
