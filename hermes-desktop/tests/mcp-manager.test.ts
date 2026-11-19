import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { McpManager } from '../src/main/mcp/manager'
import type { McpServerRecord } from '../src/main/store'
import type { ToolImpl } from '../src/main/tools'
import { activeTools, authorize } from '../src/main/tools'
import type { ToolSettings } from '../src/shared/types'

const FIXTURE = path.resolve(__dirname, 'fixtures/mcp-server.mjs')
const plain = (value: string) => ({ encrypted: false, value })
const rec = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 'srv1', name: 'Fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE],
  env: {}, headers: {}, policy: 'ask', toolPolicies: {}, ...over
})
const mgr = () => new McpManager({ decrypt: (s) => s?.value })
const find = (m: McpManager, tool: string): ToolImpl => m.tools().find((t) => t.name.endsWith(`__${tool}`))!
const ctx = () => ({ workspace: '', signal: new AbortController().signal })
const cfg = (): ToolSettings => ({ enabled: true, workspace: '', policies: {} })

const managers: McpManager[] = []
const make = () => { const m = mgr(); managers.push(m); return m }
afterAll(async () => { await Promise.all(managers.map((m) => m.closeAll())) })

describe('stdio server', () => {
  it('connects, lists tools with sanitized unique names, and reports server info', async () => {
    const m = make()
    m.sync([rec()])
    await m.settled(15000)
    const [s] = m.status()
    expect(s.state).toBe('connected')
    expect(s.serverInfo).toBe('fixture 1.2.3')
    const names = s.tools.map((t) => t.exposedName)
    expect(names).toContain('fixture__echo')
    expect(names).toContain('fixture__weird_name_')
    expect(names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(s.tools.find((t) => t.name === 'echo')?.readOnly).toBe(true)
    const echo = m.tools().find((t) => t.name === 'fixture__echo')!
    expect(echo.parameters).toMatchObject({ type: 'object', properties: { message: { type: 'string' } } })
    expect(echo.external).toBe(true)
    expect(echo.label).toBe('Fixture · echo')
  })

  it('calls tools, surfaces isError as ToolError, and describes images', async () => {
    const m = make(); m.sync([rec()]); await m.settled(15000)
    expect(await find(m, 'echo').run({ message: 'hi' }, ctx())).toBe('echo: hi')
    expect(await find(m, 'add').run({ a: 2, b: 40 }, ctx())).toBe('42')
    await expect(find(m, 'fail').run({}, ctx())).rejects.toThrow('something went wrong')
    expect(await find(m, 'image').run({}, ctx())).toMatch(/\[image: image\/png/)
    await expect(find(m, 'add').run({ a: 'x' }, ctx())).rejects.toThrow(/MCP error/) // schema validation by server
  })

  it('passes decrypted env vars to the child process', async () => {
    const m = make(); m.sync([rec({ env: { MY_SECRET: plain('s3cr3t') } })]); await m.settled(15000)
    expect(await find(m, 'env').run({ name: 'MY_SECRET' }, ctx())).toBe('MY_SECRET=s3cr3t')
  })

  it('cancels an in-flight call via AbortSignal', async () => {
    const m = make(); m.sync([rec()]); await m.settled(15000)
    const ctl = new AbortController()
    const p = find(m, 'slow').run({}, { workspace: '', signal: ctl.signal })
    setTimeout(() => ctl.abort(), 200)
    const t0 = Date.now()
    await expect(p).rejects.toThrow(/Cancelled/)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('picks up tools added at runtime (tools/list_changed)', async () => {
    const m = make(); m.sync([rec()]); await m.settled(15000)
    expect(m.tools().some((t) => t.name.endsWith('__dynamic'))).toBe(false)
    await find(m, 'add_tool').run({}, ctx())
    await new Promise((r) => setTimeout(r, 500))
    expect(m.tools().some((t) => t.name.endsWith('__dynamic'))).toBe(true)
  })

  it('reports a clear error (with server stderr) when the command is bad or crashes', async () => {
    const m = make()
    m.sync([rec({ id: 'bad1', command: 'definitely-not-a-real-command-xyz', args: [] }), rec({ id: 'bad2', command: process.execPath, args: ['-e', 'console.error("boom: missing API key"); process.exit(1)'] })])
    await m.settled(15000)
    const [a, b] = m.status()
    expect(a.state).toBe('error')
    expect(a.error).toBeTruthy()
    expect(b.state).toBe('error')
    expect(`${b.error} ${b.stderr}`).toContain('missing API key')
    expect(m.tools()).toEqual([])
  })

  it('disabled servers are not started; enabling later connects; removal disconnects', async () => {
    const m = make()
    m.sync([rec({ enabled: false })])
    expect(m.status()[0].state).toBe('disabled')
    m.sync([rec({ enabled: true })])
    await m.settled(15000)
    expect(m.status()[0].state).toBe('connected')
    m.sync([])
    expect(m.status()).toEqual([])
    expect(m.tools()).toEqual([])
  })

  it('name/policy edits do not reconnect; policy flows into authorization', async () => {
    const m = make(); m.sync([rec()]); await m.settled(15000)
    const before = find(m, 'echo')
    expect(await authorize(before, {}, cfg(), ctx(), new Set())).toBe('ask') // default: ask

    m.sync([rec({ name: 'Renamed', policy: 'allow', toolPolicies: { add: 'deny' } })])
    expect(m.status()[0].state).toBe('connected') // no reconnect
    const names = m.tools().map((t) => t.name)
    expect(names).toContain('renamed__echo')
    expect(await authorize(find(m, 'echo'), {}, cfg(), ctx(), new Set())).toBe('allow')
    expect(activeTools(cfg(), m.tools()).some((t) => t.name === 'renamed__add')).toBe(false) // per-tool deny hides it
    expect(activeTools(cfg(), m.tools()).some((t) => t.name === 'renamed__echo')).toBe(true)
    expect(activeTools({ ...cfg(), enabled: false }, m.tools())).toEqual([]) // master switch gates MCP too
    // user override beats server policy
    expect(await authorize(find(m, 'echo'), {}, { ...cfg(), policies: { renamed__echo: 'ask' } }, ctx(), new Set())).toBe('ask')
  })

  it('two servers with the same name get distinct tool names', async () => {
    const m = make(); m.sync([rec({ id: 'a', name: 'Same' }), rec({ id: 'b', name: 'Same' })]); await m.settled(15000)
    const names = m.tools().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((n) => n.includes('__echo'))).toHaveLength(2)
  })

  it('restart reconnects a crashed/closed server', async () => {
    const m = make(); m.sync([rec()]); await m.settled(15000)
    m.restart('srv1')
    expect(m.status()[0].state).toBe('connecting')
    await m.settled(15000)
    expect(m.status()[0].state).toBe('connected')
    expect(await find(m, 'echo').run({ message: 'again' }, ctx())).toBe('echo: again')
  })
})

describe('streamable HTTP server', () => {
  let child: ChildProcess
  const port = 38000 + Math.floor(Math.random() * 1000)
  beforeAll(async () => {
    child = spawn(process.execPath, [FIXTURE, '--http', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      child.stderr!.on('data', (d) => String(d).includes('http fixture on') && resolve())
      child.on('exit', (c) => reject(new Error('fixture exited ' + c)))
      setTimeout(() => reject(new Error('fixture start timeout')), 10000)
    })
  })
  afterAll(() => { child.kill() })

  it('connects over HTTP, sends configured headers, calls tools', async () => {
    const m = make()
    m.sync([rec({ id: 'h', transport: 'http', command: undefined, args: undefined, url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Test': plain('token-123') } })])
    await m.settled(15000)
    expect(m.status()[0]).toMatchObject({ state: 'connected', serverInfo: 'fixture 1.2.3' })
    expect(await find(m, 'echo').run({ message: 'over http' }, ctx())).toBe('echo: over http')
    expect(await find(m, 'header').run({ name: 'x-test' }, ctx())).toBe('x-test=token-123')
  })

  it('reports an error for an unreachable URL and an invalid URL', async () => {
    const m = make()
    m.sync([
      rec({ id: 'x', transport: 'http', command: undefined, args: undefined, url: 'http://127.0.0.1:1/mcp' }),
      rec({ id: 'y', transport: 'http', command: undefined, args: undefined, url: 'not a url' }),
      rec({ id: 'z', transport: 'http', command: undefined, args: undefined, url: 'file:///etc/passwd' })
    ])
    await m.settled(20000)
    const st = m.status()
    expect(st.map((s) => s.state)).toEqual(['error', 'error', 'error'])
    expect(st[1].error).toMatch(/Invalid server URL/)
    expect(st[2].error).toMatch(/http/)
  })
})
