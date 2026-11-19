// Fails the build if the compiled app would break once packaged. The classic failure: it works in `npm run dev`
// (where node_modules is right there) but a module the main process `require()`s at runtime isn't shipped.
//   - every bare require() in out/main + out/preload must be a Node/Electron builtin or a runtime `dependency`
//   - it must actually be installed
//   - renderer output must be self-contained (no require / bare imports)
//   - the files the app loads at startup must exist
import { builtinModules } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const deps = new Set(Object.keys(pkg.dependencies ?? {}))
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron'])
const problems = []
const fail = (m) => problems.push(m)

const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

function bareRequires(file) {
  const src = readFileSync(file, 'utf8')
  return [...new Set([...src.matchAll(/\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)/g)].map((m) => m[1]))]
}

for (const entry of ['out/main/index.js', 'out/preload/index.js']) {
  const file = path.join(root, entry)
  if (!existsSync(file)) { fail(`${entry} is missing — run the build first`); continue }
  for (const spec of bareRequires(file)) {
    if (builtins.has(spec)) continue
    const name = pkgName(spec)
    if (!deps.has(name)) fail(`${entry} requires "${spec}" but "${name}" is not in package.json "dependencies" (it would be missing from the packaged app)`)
    else if (!existsSync(path.join(root, 'node_modules', name))) fail(`"${name}" is a dependency but not installed`)
  }
}
if ([...deps].some((d) => d === 'electron')) fail('"electron" must be a devDependency, not a dependency')

const renderer = path.join(root, 'out/renderer')
if (!existsSync(path.join(renderer, 'index.html'))) fail('out/renderer/index.html is missing')
else {
  const html = readFileSync(path.join(renderer, 'index.html'), 'utf8')
  for (const [, ref] of html.matchAll(/(?:src|href)="(\.[^"]+|\/[^"]+)"/g)) {
    if (!existsSync(path.join(renderer, ref.replace(/^\.?\//, '')))) fail(`index.html references ${ref}, which doesn't exist`)
  }
  if (!/Content-Security-Policy/.test(html)) fail('production index.html has no Content-Security-Policy')
  const assets = path.join(renderer, 'assets')
  for (const f of existsSync(assets) ? readdirSync(assets) : []) {
    if (!f.endsWith('.js')) continue
    if (/\brequire\(\s*["'][^"']+["']\s*\)/.test(readFileSync(path.join(assets, f), 'utf8'))) fail(`renderer bundle ${f} calls require() — the sandboxed renderer has no Node`)
  }
}
for (const f of ['build/icon.png']) if (!existsSync(path.join(root, f))) fail(`${f} is missing (run npm run icons)`)

const kb = (p) => Math.round(statSync(p).size / 1024)
if (problems.length) {
  console.error('✗ bundle verification failed:\n' + problems.map((p) => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log(`✓ bundle OK — main ${kb(path.join(root, 'out/main/index.js'))} KB, preload ${kb(path.join(root, 'out/preload/index.js'))} KB; runtime deps: ${[...deps].join(', ')}`)
