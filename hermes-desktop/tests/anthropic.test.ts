import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { clearModelCache, friendlyError, listClaudeModels, streamAnthropic, toAnthropicMessages, toAnthropicTools } from '../src/main/anthropic'
import type { StreamEvent } from '../src/main/openai'
import { DEFAULT_ANTHROPIC_OPTIONS, fallbackEligible, isOfficialAnthropicUrl, normalizeAnthropicOptions, refusalMessage, type AnthropicOptions } from '../src/shared/anthropic'
import type { Message } from '../src/shared/types'

// ---------- a tiny fake of the Anthropic API ----------
type Block =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
interface Reply {
  blocks?: Block[]
  stop?: string
  stopDetails?: unknown
  usage?: Record<string, unknown>
  model?: string
  extraContent?: unknown[]
  /** raw HTTP override (errors) */
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** write the first events then never finish */
  hang?: boolean
}
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }

let server: http.Server
let base = ''
let seen: Seen[] = []
let modelMeta: any
let messageReplies: Reply[] = []

const chunk = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, 'gs')) ?? ['']

function sse(r: Reply, model: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })
  let i = 0
  for (const b of r.blocks ?? []) {
    if (b.type === 'thinking') {
      out += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } })
      for (const c of chunk(b.text, 4)) out += ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: c } })
      out += ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } })
    } else if (b.type === 'text') {
      out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
      for (const c of chunk(b.text, 3)) out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c } })
    } else {
      out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      for (const c of chunk(JSON.stringify(b.input), 7)) out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: c } })
    }
    out += ev('content_block_stop', { index: i })
    i++
  }
  out += ev('message_delta', { delta: { stop_reason: r.stop ?? 'end_turn', stop_sequence: null, ...(r.stopDetails ? { stop_details: r.stopDetails } : {}) }, usage: { output_tokens: 42, ...(r.usage ?? {}) } })
  out += ev('message_stop', {})
  return out
}

beforeEach(async () => {
  clearModelCache()
  seen = []
  messageReplies = []
  modelMeta = { max_tokens: 128000, max_input_tokens: 1000000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true } } }
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      const path = req.url!.split('?')[0]
      const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(JSON.stringify(obj))
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return json(200, { data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5' })
      }
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        return modelMeta === 'fail' ? json(404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } }) : json(200, { id: path.split('/').pop(), type: 'model', display_name: 'X', created_at: '2026-01-01T00:00:00Z', ...modelMeta })
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const r = messageReplies.shift() ?? { blocks: [{ type: 'text', text: 'ok' }] }
        if (r.status) return json(r.status, r.body ?? { type: 'error', error: { type: 'api_error', message: 'boom' } }, { 'x-should-retry': 'false', ...(r.headers ?? {}) })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const text = sse(r, r.model ?? body.model)
        if (r.hang) {
          res.write(text.slice(0, text.indexOf('event: content_block_stop')))
          return // never ends
        }
        return void res.end(text)
      }
      json(404, { type: 'error', error: { type: 'not_found_error', message: 'no route' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }))

const opts = (over: Partial<AnthropicOptions> = {}): AnthropicOptions => ({ ...DEFAULT_ANTHROPIC_OPTIONS, ...over })
const run = async (over: Partial<Parameters<typeof streamAnthropic>[0]> = {}) => {
  const evs: StreamEvent[] = []
  for await (const e of streamAnthropic({ baseUrl: base, apiKey: 'sk-ant-test', model: 'claude-opus-5-5', system: 'You are helpful.', messages: [{ role: 'user', content: 'hi' }], options: opts(), ...over })) evs.push(e)
  return evs
}
const post = () => seen.filter((s) => s.method === 'POST')

describe('streamAnthropic — request', () => {
  it('sends auth + version headers, system, auto prompt caching, and NO sampling parameters', async () => {
    await run()
    const r = post()[0]
    expect(r.headers.authorization).toBe('Bearer sk-ant-test') // SDK 1.x sends the key as a Bearer token
    expect(r.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r.url).toBe('/v1/messages')
    expect(r.body).toMatchObject({ model: 'claude-opus-5-5', system: 'You are helpful.', stream: true, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: 'hi' }] })
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config', 'fallbacks', 'tools']) expect(r.body, k).not.toHaveProperty(k)
  })
  it('caps max_tokens at 64k and at the model’s real limit (from the Models API); falls back to 16k when unknown', async () => {
    await run()
    expect(post()[0].body.max_tokens).toBe(64000)
    clearModelCache(); seen = []; modelMeta = { max_tokens: 4096 }
    await run({ model: 'claude-small' })
    expect(post()[0].body.max_tokens).toBe(4096)
    clearModelCache(); seen = []; modelMeta = 'fail'
    await run({ model: 'claude-unknown' })
    expect(post()[0].body.max_tokens).toBe(16000)
  })
  it('caches model info (one /v1/models/<id> lookup for repeated turns)', async () => {
    await run(); await run()
    expect(seen.filter((s) => s.url.startsWith('/v1/models/')).length).toBe(1)
  })
  it('promptCaching off → no cache_control', async () => {
    await run({ options: opts({ promptCaching: false }) })
    expect(post()[0].body).not.toHaveProperty('cache_control')
  })
  it('reasoning summaries and effort are opt-in and gated by the model’s capabilities', async () => {
    await run({ options: opts({ showThinking: true, effort: 'high' }) })
    expect(post()[0].body).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
    clearModelCache(); seen = []
    modelMeta = { max_tokens: 64000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: false } } }, effort: { supported: false } } }
    await run({ options: opts({ showThinking: true, effort: 'high' }) })
    expect(post()[0].body).not.toHaveProperty('thinking')
    expect(post()[0].body).not.toHaveProperty('output_config')
  })
  it('maps tools to input_schema', async () => {
    const tools = toAnthropicTools([{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }])
    expect(tools).toEqual([{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }])
    await run({ tools })
    expect(post()[0].body.tools).toEqual(tools)
  })
})

describe('streamAnthropic — response', () => {
  it('streams text and thinking deltas, then meta with verbatim raw blocks (signature kept) and usage', async () => {
    messageReplies = [{ blocks: [{ type: 'thinking', text: 'Let me think.', signature: 'sig-abc' }, { type: 'text', text: 'Hello there!' }], usage: { cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }]
    const evs = await run()
    expect(evs.filter((e) => e.type === 'thinking').map((e: any) => e.text).join('')).toBe('Let me think.')
    expect(evs.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('Hello there!')
    const meta: any = evs.find((e) => e.type === 'meta')
    expect(meta.meta.raw).toHaveLength(2)
    expect(meta.meta.raw[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think.', signature: 'sig-abc' })
    expect(meta.meta.raw[1]).toMatchObject({ type: 'text', text: 'Hello there!' })
    expect(meta.meta.usage).toMatchObject({ input: 25, output: 42, cacheRead: 20, cacheWrite: 5 })
    expect(meta.meta.servedBy).toBeUndefined()
    expect(evs.some((e) => e.type === 'tool_calls')).toBe(false)
  })
  it('assembles streamed tool_use input; meta comes BEFORE tool_calls', async () => {
    messageReplies = [{ stop: 'tool_use', blocks: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts', offset: 3 } }, { type: 'tool_use', id: 'toolu_2', name: 'list_dir', input: {} }] }]
    const evs = await run()
    const kinds = evs.map((e) => e.type)
    expect(kinds.indexOf('meta')).toBeLessThan(kinds.indexOf('tool_calls'))
    const calls: any = evs.find((e) => e.type === 'tool_calls')
    expect(calls.calls).toEqual([{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"src/a.ts","offset":3}' }, { id: 'toolu_2', name: 'list_dir', arguments: '{}' }])
    const meta: any = evs.find((e) => e.type === 'meta')
    expect(meta.meta.raw.map((b: any) => b.type)).toEqual(['text', 'tool_use', 'tool_use'])
  })
  it('refuses to run tool calls cut off by max_tokens', async () => {
    messageReplies = [{ stop: 'max_tokens', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a', content: 'x' } }] }]
    await expect(run()).rejects.toThrow(/output limit while writing a tool call/)
  })
  it('surfaces refusals (category + explanation), without raw blocks or tool calls', async () => {
    messageReplies = [{ stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: 'Not allowed.' }, blocks: [{ type: 'text', text: 'I can' }] }]
    const evs = await run()
    const meta: any = evs.find((e) => e.type === 'meta')
    expect(meta.meta.refusal).toEqual({ category: 'cyber', explanation: 'Not allowed.' })
    expect(meta.meta.raw).toBeUndefined()
    expect(refusalMessage(meta.meta.refusal)).toBe('Claude declined to answer (category: cyber). Not allowed. Try rephrasing your request.')
  })
  it('reports context-window overflow clearly', async () => {
    messageReplies = [{ stop: 'model_context_window_exceeded', blocks: [] }]
    await expect(run()).rejects.toThrow(/no longer fits/)
  })
})

describe('refusal fallback', () => {
  it('eligibility: official API URL + supported models only', () => {
    expect(fallbackEligible('claude-opus-5-5', 'https://api.anthropic.com')).toBe(true)
    expect(fallbackEligible('claude-fable-5-1', '')).toBe(true)
    expect(fallbackEligible('claude-sonnet-5-5', 'https://api.anthropic.com/')).toBe(true)
    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'gpt-4']) expect(fallbackEligible(m, 'https://api.anthropic.com'), m).toBe(false)
    expect(fallbackEligible('claude-opus-5-5', 'https://my-proxy.example.com')).toBe(false)
    expect(isOfficialAnthropicUrl('nonsense')).toBe(false)
  })
  it('is not used for ineligible endpoints (plain /v1/messages, no beta header, no fallbacks field)', async () => {
    await run()
    expect(post()[0].url).toBe('/v1/messages')
    expect(post()[0].headers['anthropic-beta']).toBeUndefined()
  })
  it('uses the beta endpoint with fallbacks:"default" when eligible; marks servedBy when a fallback answered', async () => {
    messageReplies = [{ model: 'claude-opus-4-8', blocks: [{ type: 'text', text: 'ok' }], extraContent: [], usage: { iterations: [{ type: 'message' }, { type: 'fallback_message' }] } }]
    const evs = await run({ forceFallback: true })
    expect(post()[0].url).toBe('/v1/messages') // beta features ride on the same URL via the anthropic-beta header
    expect(String(post()[0].headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(post()[0].body.fallbacks).toBe('default')
    const meta: any = evs.find((e) => e.type === 'meta')
    expect(meta.meta.servedBy).toBe('claude-opus-4-8')
  })
  it('off by option → never used', async () => {
    await run({ forceFallback: true, options: opts({ refusalFallback: false }) })
    expect(post()[0].body).not.toHaveProperty('fallbacks')
  })
  it('safety net: if the fallback beta is rejected (400 mentioning fallback) it retries once without it', async () => {
    messageReplies = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks is not supported for this organization' } } }, { blocks: [{ type: 'text', text: 'recovered' }] }]
    const evs = await run({ forceFallback: true })
    expect(post()).toHaveLength(2)
    expect(post()[0].body.fallbacks).toBe('default')
    expect(post()[1].body).not.toHaveProperty('fallbacks')
    expect(evs.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('recovered')
  })
  it('does NOT retry unrelated 400s', async () => {
    messageReplies = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } } }]
    await expect(run({ forceFallback: true })).rejects.toThrow(/rejected the request \(400\): .*max_tokens too large/)
    expect(post()).toHaveLength(1)
  })
})

describe('errors, abort, models', () => {
  it.each([
    [401, 'Authentication failed (401)'],
    [403, 'Permission denied (403)'],
    [404, 'Not found (404)'],
    [429, 'Rate limited (429)'],
    [500, 'Anthropic API error (500)'],
    [529, 'overloaded (529)']
  ])('maps HTTP %i to a helpful message', async (status, text) => {
    messageReplies = [{ status, body: { type: 'error', error: { type: 'x', message: 'detail' } } }]
    await expect(run()).rejects.toThrow(text)
  })
  it('explains an unreachable server and a missing key', async () => {
    await expect(run({ baseUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/Could not reach http:\/\/127\.0\.0\.1:1/)
    const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN }
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN
    try {
      await expect(run({ apiKey: undefined })).rejects.toThrow(/No API key is set/)
    } finally {
      if (saved.k) process.env.ANTHROPIC_API_KEY = saved.k
      if (saved.t) process.env.ANTHROPIC_AUTH_TOKEN = saved.t
    }
  })
  it('aborts mid-stream with an AbortError', async () => {
    messageReplies = [{ hang: true, blocks: [{ type: 'text', text: 'partial text that never finishes' }] }]
    const ctl = new AbortController()
    const got: string[] = []
    const p = (async () => {
      for await (const e of streamAnthropic({ baseUrl: base, apiKey: 'k', model: 'claude-opus-5-5', system: '', messages: [{ role: 'user', content: 'x' }], options: opts(), signal: ctl.signal })) {
        if (e.type === 'text') { got.push(e.text); ctl.abort() }
      }
    })()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(got.length).toBeGreaterThan(0)
  })
  it('lists models in the API’s own order (newest first, not alphabetical) and maps auth errors', async () => {
    expect(await listClaudeModels(base, 'k')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
    expect(friendlyError(new Error('plain'), base).message).toBe('plain')
  })
  it('normalizes options defensively', () => {
    expect(normalizeAnthropicOptions(undefined)).toEqual(DEFAULT_ANTHROPIC_OPTIONS)
    expect(normalizeAnthropicOptions({ effort: 'bogus', showThinking: 'yes', promptCaching: 0, refusalFallback: false })).toEqual({ effort: '', showThinking: false, promptCaching: true, refusalFallback: false })
    expect(normalizeAnthropicOptions({ effort: 'xhigh', showThinking: true })).toMatchObject({ effort: 'xhigh', showThinking: true })
  })
})

describe('toAnthropicMessages', () => {
  const m = (o: Partial<Message>): Message => ({ id: String(Math.random()), role: 'user', content: '', createdAt: 0, ...o }) as Message
  it('plain conversation', () => {
    expect(toAnthropicMessages([m({ content: 'hi' }), m({ role: 'assistant', content: 'hello' }), m({ content: 'more' })])).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, { role: 'user', content: 'more' }
    ])
  })
  it('tool round-trip: raw blocks replayed verbatim; ONE user message of tool_results (errors flagged)', () => {
    const raw = [{ type: 'thinking', thinking: 'hmm', signature: 'SIG' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'toolu_b', name: 'run_command', input: { command: 'ls' } }]
    const out = toAnthropicMessages([
      m({ content: 'go' }),
      m({ role: 'assistant', content: 'Reading.', raw, toolCalls: [
        { id: 'toolu_a', name: 'read_file', arguments: '{"path":"a"}', status: 'done', result: 'file text' },
        { id: 'toolu_b', name: 'run_command', arguments: '{"command":"ls"}', status: 'denied', result: 'The user denied this tool call.' }
      ] }),
      m({ role: 'assistant', content: 'Done.' })
    ])
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(out[1].content).toBe(raw) // verbatim, same object — thinking signature untouched
    expect(out[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'file text' },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'The user denied this tool call.', is_error: true }
    ])
  })
  it('without raw (history from another provider) it rebuilds tool_use blocks; bad JSON arguments become {}', () => {
    const out = toAnthropicMessages([m({ content: 'go' }), m({ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'x', arguments: '{oops', status: 'error', result: 'bad' }] })])
    expect(out[1].content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'x', input: {} }])
    expect((out[2].content as any[])[0]).toMatchObject({ tool_use_id: 'call_1', is_error: true })
  })
  it('interrupted calls get a synthetic result; a following user message merges AFTER the tool_results', () => {
    const out = toAnthropicMessages([m({ content: 'go' }), m({ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', arguments: '{}', status: 'running' }] }), m({ content: 'next question' })])
    expect(out).toHaveLength(3)
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'Interrupted before completion.' }, { type: 'text', text: 'next question' }])
  })
  it('skips failed/partial/empty assistant turns (and merges the user messages around them)', () => {
    const out = toAnthropicMessages([m({ content: 'a' }), m({ role: 'assistant', content: 'partial', error: 'boom' }), m({ role: 'assistant', content: '' }), m({ content: 'b' })])
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])
  })
  it('expands /skill invocations from their snapshot', () => {
    const out = toAnthropicMessages([m({ content: '/review check a.ts', skill: { name: 'review', text: 'Be careful.' } })])
    expect(String(out[0].content)).toContain('invoked the skill "review"')
    expect(String(out[0].content)).toContain('Be careful.')
    expect(String(out[0].content).endsWith('check a.ts')).toBe(true)
  })
})
