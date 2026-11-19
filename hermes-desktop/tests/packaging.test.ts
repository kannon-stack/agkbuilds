import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { APP_ID, APP_NAME } from '../src/shared/types'

const root = path.resolve(__dirname, '..')
const req = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const loadConfig = (env: Record<string, string | undefined> = {}) => {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k]
  const file = req.resolve('../electron-builder.config.cjs')
  delete req.cache[file]
  try {
    return req(file)
  } finally {
    process.env = saved
  }
}

/** Bare package specifiers imported by a set of source files. */
function imports(dir: string): Set<string> {
  const out = new Set<string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e)) {
        // real import statements only: `… from 'x'`, side-effect `import 'x'` at line start, dynamic `import('x')`
        const src = readFileSync(p, 'utf8')
        const specs = [...src.matchAll(/^(?:import|export)\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/^import\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)]
        for (const m of specs) {
          const s = m[1]
          if (s.startsWith('.') || s.startsWith('/')) continue
          if (s.startsWith('node:') || s === 'electron') continue
          out.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])
        }
      }
    }
  }
  walk(dir)
  return out
}

describe('electron-builder config', () => {
  const cfg = loadConfig({ TALARIA_UNFUSED: undefined, TALARIA_NO_EDIT_EXE: undefined, ELECTRON_DIST: undefined })
  it('matches the app identity used in code', () => {
    expect(cfg.appId).toBe(APP_ID)
    expect(cfg.productName).toBe(APP_NAME)
    expect(pkg.productName).toBe(APP_NAME)
    expect(pkg.desktopName).toMatch(/\.desktop$/)
  })
  it('ships only the build output, with the icon as an extra resource, and no update channel', () => {
    expect(cfg.files).toContain('out/**/*')
    expect(cfg.files.join(' ')).not.toMatch(/src|tests|node_modules/)
    expect(cfg.extraResources).toEqual([{ from: 'build/icon.png', to: 'icon.png' }])
    expect(cfg.publish).toBeNull()
    expect(cfg.asar).toBe(true)
  })
  it('hardens the Electron binary by default (fuses) and can be relaxed only for test builds', () => {
    expect(cfg.electronFuses).toMatchObject({ runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true })
    expect(loadConfig({ TALARIA_UNFUSED: '1' }).electronFuses).toBeUndefined()
  })
  it('never wipes user data on uninstall and uses hardened runtime + entitlements on macOS', () => {
    expect(cfg.nsis.deleteAppDataOnUninstall).toBe(false)
    expect(cfg.mac.hardenedRuntime).toBe(true)
    expect(existsSync(path.join(root, cfg.mac.entitlements))).toBe(true)
    expect(readFileSync(path.join(root, cfg.mac.entitlements), 'utf8')).toContain('allow-jit')
  })
  it('targets every platform and notarizes only when credentials are present', () => {
    expect(cfg.linux.target).toEqual(expect.arrayContaining(['AppImage', 'deb']))
    expect(JSON.stringify(cfg.win.target)).toContain('nsis')
    expect(JSON.stringify(cfg.mac.target)).toContain('dmg')
    expect(cfg.mac.notarize).toBe(false)
    expect(loadConfig({ APPLE_TEAM_ID: 'ABCDE12345' }).mac.notarize).toBe(true)
    expect(loadConfig({ TALARIA_NO_EDIT_EXE: '1' }).win.signAndEditExecutable).toBe(false)
    expect(cfg.win.signAndEditExecutable).toBeUndefined()
  })
  it('npm scripts always pass the config explicitly (electron-builder ignores this filename otherwise)', () => {
    for (const s of ['pack', 'dist', 'dist:linux', 'dist:win', 'dist:mac']) expect(pkg.scripts[s], s).toContain('--config electron-builder.config.cjs')
    for (const s of ['dist', 'dist:linux', 'dist:win', 'dist:mac', 'pack']) expect(pkg.scripts[s], s).toContain('verify:bundle')
  })
})

describe('icons', () => {
  it('has a 1024² PNG master (electron-builder derives .ico/.icns from it)', () => {
    const f = path.join(root, 'build/icon.png')
    const b = readFileSync(f)
    expect(b.subarray(1, 4).toString()).toBe('PNG')
    expect(b.readUInt32BE(16)).toBe(1024)
    expect(b.readUInt32BE(20)).toBe(1024)
    expect(existsSync(path.join(root, 'build/icon.svg'))).toBe(true)
  })
})

describe('runtime dependencies', () => {
  const deps = Object.keys(pkg.dependencies)
  const mainImports = new Set([...imports(path.join(root, 'src/main')), ...imports(path.join(root, 'src/preload')), ...imports(path.join(root, 'src/shared'))])
  const rendererImports = imports(path.join(root, 'src/renderer/src'))
  it('every package the main process imports at runtime is a production dependency', () => {
    for (const m of mainImports) expect(deps, `${m} is imported by main/preload but missing from "dependencies"`).toContain(m)
  })
  it('renderer-only libraries are bundled by Vite, so they must NOT ship as dependencies (bloat)', () => {
    for (const r of rendererImports) if (!mainImports.has(r)) expect(deps, `${r} is renderer-only`).not.toContain(r)
  })
  it('the only extra runtime dependency is zod (a peer dependency of the MCP SDK)', () => {
    expect(deps.filter((d) => !mainImports.has(d))).toEqual(['zod'])
    expect(pkg.devDependencies.electron).toBeTruthy()
    expect(pkg.dependencies.electron).toBeUndefined()
  })
})
