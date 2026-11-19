import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { activeTools, authorize, getTool, ToolError } from '../src/main/tools'
import { htmlToText } from '../src/main/tools/web'
import { toWire } from '../src/main/chat'
import type { ToolSettings } from '../src/shared/types'

let ws = ''
let outside = ''
const ctx = () => ({ workspace: ws, signal: new AbortController().signal })
const run = (name: string, args: unknown) => getTool(name)!.run(args, ctx())
const cfg = (over: Partial<ToolSettings> = {}): ToolSettings => ({ enabled: true, workspace: ws, policies: {}, ...over })

beforeAll(() => {
  ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ws-')))
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'outside-')))
  writeFileSync(path.join(ws, 'a.txt'), 'line1\nline2\nline3\nline4\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
  writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  mkdirSync(path.join(ws, 'sub'))
  symlinkSync(outside, path.join(ws, 'escape')) // symlink pointing out of the workspace
})
afterAll(() => {})

describe('read_file / list_dir', () => {
  it('reads files and line ranges', async () => {
    expect(await run('read_file', { path: 'a.txt' })).toContain('line3')
    const part = await run('read_file', { path: 'a.txt', offset: 2, limit: 2 })
    expect(part).toContain('[lines 2-3 of 5]')
    expect(part).toContain('line2\nline3')
    expect(part).not.toContain('line4')
  })
  it('rejects binary, directories and missing files with model-readable errors', async () => {
    await expect(run('read_file', { path: 'bin.dat' })).rejects.toThrow(/binary/)
    await expect(run('read_file', { path: 'sub' })).rejects.toThrow(/directory/)
    await expect(run('read_file', { path: 'nope.txt' })).rejects.toThrow(/not found/)
    await expect(run('read_file', {})).rejects.toBeInstanceOf(ToolError)
  })
  it('lists directories, dirs first', async () => {
    const out = await run('list_dir', { path: '.' })
    expect(out.split('\n').slice(0, 2)).toEqual(['escape/', 'sub/'])
    expect(out).toContain('a.txt')
  })
})

describe('write_file / edit_file', () => {
  it('creates nested files and reports create vs overwrite', async () => {
    expect(await run('write_file', { path: 'new/dir/f.txt', content: 'hi' })).toMatch(/Created/)
    expect(readFileSync(path.join(ws, 'new/dir/f.txt'), 'utf8')).toBe('hi')
    expect(await run('write_file', { path: 'new/dir/f.txt', content: 'yo' })).toMatch(/Overwrote/)
  })
  it('refuses writes outside the workspace: ../, absolute, and through a symlink', async () => {
    await expect(run('write_file', { path: '../evil.txt', content: 'x' })).rejects.toThrow(/outside the workspace/)
    await expect(run('write_file', { path: path.join(outside, 'evil.txt'), content: 'x' })).rejects.toThrow(/outside/)
    await expect(run('write_file', { path: 'escape/evil.txt', content: 'x' })).rejects.toThrow(/outside/)
    await expect(run('edit_file', { path: 'escape/secret.txt', old_string: 'top', new_string: 'x' })).rejects.toThrow(/outside/)
    expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false)
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
  })
  it('edit_file requires exactly one match', async () => {
    writeFileSync(path.join(ws, 'e.txt'), 'foo bar foo')
    await expect(run('edit_file', { path: 'e.txt', old_string: 'foo', new_string: 'X' })).rejects.toThrow(/2 places/)
    await expect(run('edit_file', { path: 'e.txt', old_string: 'zzz', new_string: 'X' })).rejects.toThrow(/not found/)
    await run('edit_file', { path: 'e.txt', old_string: 'bar', new_string: '$&' }) // `$&` must be literal
    expect(readFileSync(path.join(ws, 'e.txt'), 'utf8')).toBe('foo $& foo')
  })
})

describe('authorize (policy)', () => {
  const t = (n: string) => getTool(n)!
  it('auto-allows reads inside the workspace, asks for outside / symlink-escape', async () => {
    const empty = new Set<string>()
    expect(await authorize(t('read_file'), { path: 'a.txt' }, cfg(), ctx(), empty)).toBe('allow')
    expect(await authorize(t('read_file'), { path: path.join(outside, 'secret.txt') }, cfg(), ctx(), empty)).toBe('ask')
    expect(await authorize(t('read_file'), { path: 'escape/secret.txt' }, cfg(), ctx(), empty)).toBe('ask')
    expect(await authorize(t('read_file'), { path: '../x' }, cfg({ policies: { read_file: 'allow' } }), ctx(), empty)).toBe('ask')
  })
  it('asks for writes/exec/network by default, honors allow/deny and chat approvals', async () => {
    const empty = new Set<string>()
    for (const n of ['write_file', 'edit_file', 'run_command', 'web_fetch']) {
      expect(await authorize(t(n), {}, cfg(), ctx(), empty)).toBe('ask')
    }
    expect(await authorize(t('run_command'), {}, cfg({ policies: { run_command: 'allow' } }), ctx(), empty)).toBe('allow')
    expect(await authorize(t('run_command'), {}, cfg({ policies: { run_command: 'deny' } }), ctx(), empty)).toBe('deny')
    expect(await authorize(t('run_command'), {}, cfg(), ctx(), new Set(['run_command']))).toBe('allow')
  })
  it('only offers workspace tools when a workspace is set, nothing when disabled or denied', () => {
    expect(activeTools(cfg({ workspace: '' })).map((x) => x.name)).toEqual(['web_fetch'])
    expect(activeTools(cfg({ enabled: false }))).toEqual([])
    expect(activeTools(cfg({ policies: { run_command: 'deny' } })).map((x) => x.name)).not.toContain('run_command')
    expect(activeTools(cfg()).length).toBe(6)
  })
})

describe('run_command', () => {
  it('captures output and exit code, runs in the workspace', async () => {
    const out = await run('run_command', { command: 'pwd && echo err 1>&2 && exit 3' })
    expect(out).toMatch(/^Exit code 3\./)
    expect(out).toContain(ws)
    expect(out).toContain('err')
  })
  it('kills on timeout (including child processes)', async () => {
    const t0 = Date.now()
    const out = await run('run_command', { command: 'sleep 30 & sleep 30', timeout_seconds: 1 })
    expect(out).toMatch(/Timed out after 1s/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('kills on abort', async () => {
    const ctl = new AbortController()
    const p = getTool('run_command')!.run({ command: 'sleep 30' }, { workspace: ws, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 200)
    expect(await p).toMatch(/Cancelled by user/)
  })
  it('truncates huge output', async () => {
    const out = await run('run_command', { command: 'yes x | head -c 200000' })
    expect(out.length).toBeLessThan(30_000)
    expect(out).toContain('characters omitted')
  })
})

describe('web_fetch', () => {
  let srv: http.Server
  let base = ''
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><script>evil()</script><h1>Hello</h1><p>World&nbsp;here</p></body></html>')
      } else if (req.url === '/img') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end('png')
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('nope')
      }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })
  afterAll(() => { srv.closeAllConnections(); srv.close() })

  it('converts html to text and strips scripts/styles', async () => {
    const out = await run('web_fetch', { url: `${base}/page` })
    expect(out).toContain('HTTP 200')
    expect(out).toContain('# Hi & bye')
    expect(out).toContain('Hello')
    expect(out).toContain('World here')
    expect(out).not.toContain('evil()')
    expect(out).not.toContain('x{}')
  })
  it('reports status for non-200, rejects non-text and non-http', async () => {
    expect(await run('web_fetch', { url: `${base}/missing` })).toContain('HTTP 404')
    await expect(run('web_fetch', { url: `${base}/img` })).rejects.toThrow(/Not text/)
    await expect(run('web_fetch', { url: 'file:///etc/passwd' })).rejects.toThrow(/http/)
    await expect(run('web_fetch', { url: 'not a url' })).rejects.toThrow(/Invalid URL/)
  })
  it('htmlToText handles list items', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toContain('- a')
  })
})

describe('toWire', () => {
  it('expands tool calls into assistant tool_calls + tool messages, skips errored/empty', () => {
    const wire = toWire([
      { id: '1', role: 'user', content: 'list files', createdAt: 0 },
      { id: '2', role: 'assistant', content: 'Sure', createdAt: 0, toolCalls: [
        { id: 'c1', name: 'list_dir', arguments: '{}', status: 'done', result: 'a.txt' },
        { id: 'c2', name: 'read_file', arguments: '{}', status: 'running' } // interrupted: no result
      ] },
      { id: '3', role: 'assistant', content: 'Done.', createdAt: 0 },
      { id: '4', role: 'assistant', content: 'partial', createdAt: 0, error: 'boom' },
      { id: '5', role: 'assistant', content: '', createdAt: 0 }
    ])
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(wire[1].tool_calls?.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(wire[2]).toMatchObject({ tool_call_id: 'c1', content: 'a.txt' })
    expect(wire[3].content).toMatch(/Interrupted/)
  })
})

describe('validate (pre-approval checks)', () => {
  it('write tools reject outside-workspace paths before any prompt', async () => {
    await expect(getTool('write_file')!.validate!({ path: '../x', content: '' }, ctx())).rejects.toThrow(/outside/)
    await expect(getTool('edit_file')!.validate!({ path: 'escape/secret.txt' }, ctx())).rejects.toThrow(/outside/)
    await expect(getTool('write_file')!.validate!({ path: 'ok/new.txt', content: '' }, ctx())).resolves.toBeUndefined()
  })
})
