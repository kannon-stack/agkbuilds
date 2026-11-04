import { describe, expect, it } from 'vitest'
import { joinCommand, splitCommand } from '../src/shared/mcp'
import { exposedName, formatToolResult, normalizeSchema, parseImport, slugify } from '../src/main/mcp/util'

describe('splitCommand / joinCommand', () => {
  it('splits plain, quoted and escaped arguments', () => {
    expect(splitCommand('npx -y @scope/server /some/path')).toEqual(['npx', '-y', '@scope/server', '/some/path'])
    expect(splitCommand(`node "C:\\Program Files\\x.js" --flag='a b'`)).toEqual(['node', 'C:\\Program Files\\x.js', '--flag=a b'])
    expect(splitCommand('cmd "" tail')).toEqual(['cmd', '', 'tail'])
    expect(splitCommand('   ')).toEqual([])
  })
  it('round-trips through joinCommand', () => {
    for (const argv of [['npx', '-y', 'pkg'], ['node', 'a b.js', 'x"y'], ['cmd', '', 'z']]) {
      expect(splitCommand(joinCommand(argv[0], argv.slice(1)))).toEqual(argv)
    }
  })
})

describe('exposedName', () => {
  it('prefixes with the server slug and sanitizes', () => {
    const taken = new Set<string>()
    expect(exposedName('GitHub (work)', 'create_issue', taken)).toBe('github_work__create_issue')
    expect(exposedName('x', 'weird name!', taken)).toBe('x__weird_name_')
  })
  it('keeps names unique and within 64 chars', () => {
    const taken = new Set<string>()
    const a = exposedName('srv', 't', taken)
    const b = exposedName('srv', 't', taken)
    expect(a).not.toBe(b)
    const long = exposedName('server', 'x'.repeat(200), taken)
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(exposedName('server', 'x'.repeat(200), new Set())).toBe(long) // deterministic
  })
  it('slugify falls back for empty names', () => {
    expect(slugify('***')).toBe('server')
  })
})

describe('normalizeSchema', () => {
  it('passes object schemas through and repairs missing/non-object ones', () => {
    expect(normalizeSchema({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(normalizeSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} })
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(normalizeSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} })
  })
})

describe('formatToolResult', () => {
  it('joins text, describes non-text content, falls back to structuredContent', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(formatToolResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] })).toMatch(/\[image: image\/png, 3 bytes/)
    expect(formatToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///x', text: 'inline' } }] })).toBe('inline')
    expect(formatToolResult({ content: [], structuredContent: { n: 1 } })).toContain('"n": 1')
    expect(formatToolResult({ content: [] })).toBe('(no output)')
    expect(formatToolResult({ content: [], isError: true })).toMatch(/error without details/)
  })
  it('truncates huge output', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'x'.repeat(100_000) }] }).length).toBeLessThan(31_000)
  })
})

describe('parseImport', () => {
  it('parses the Claude Desktop format (stdio + env)', () => {
    const r = parseImport(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@mcp/fs', '/tmp'], env: { TOKEN: 'abc' } } } }))
    expect(r.errors).toEqual([])
    expect(r.servers).toEqual([{ name: 'fs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs', '/tmp'], envSet: { TOKEN: 'abc' }, policy: 'ask' }])
  })
  it('parses remote servers, headers and sse type; accepts "servers" key and bare maps', () => {
    const r = parseImport(JSON.stringify({ servers: { a: { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } }, b: { type: 'sse', url: 'http://localhost:1/sse' } } }))
    expect(r.servers.map((s) => [s.name, s.transport])).toEqual([['a', 'http'], ['b', 'sse']])
    expect(r.servers[0].headersSet).toEqual({ Authorization: 'Bearer t' })
    expect(parseImport('{"solo":{"command":"node","args":["s.js"]}}').servers[0].name).toBe('solo')
    expect(parseImport('{"command":"node","args":["s.js"]}').servers).toHaveLength(1)
  })
  it('splits a full command line given in "command" when args are absent', () => {
    expect(parseImport('{"mcpServers":{"x":{"command":"npx -y pkg"}}}').servers[0]).toMatchObject({ command: 'npx', args: ['-y', 'pkg'] })
  })
  it('reports problems per entry without dropping the good ones', () => {
    const r = parseImport(JSON.stringify({ mcpServers: { ok: { command: 'node' }, bad: { foo: 1 }, bad2: { url: 'ftp://x' }, bad3: 5 } }))
    expect(r.servers.map((s) => s.name)).toEqual(['ok'])
    expect(r.errors).toHaveLength(3)
    expect(parseImport('nope').errors[0]).toMatch(/Not valid JSON/)
  })
})
