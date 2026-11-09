import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchModels, loopbackCandidates, parsePayload, resetLoopbackCache, splitSSE, streamChat, ToolCallAccumulator, type StreamEvent } from '../src/main/openai'

describe('splitSSE', () => {
  it('splits complete events and keeps the partial tail', () => {
    const { payloads, rest } = splitSSE('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(payloads).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('data: {"c"')
  })
  it('handles CRLF and ignores comment/keepalive lines', () => {
    const { payloads } = splitSSE(': keepalive\r\n\r\ndata: hi\r\n\r\n')
    expect(payloads).toEqual(['hi'])
  })
})

describe('parsePayload', () => {
  it('extracts delta content', () => {
    expect(parsePayload('{"choices":[{"delta":{"content":"Hel"}}]}')).toEqual({ text: 'Hel' })
  })
  it('ignores role-only / empty deltas', () => {
    expect(parsePayload('{"choices":[{"delta":{"role":"assistant"}}]}')).toEqual({})
    expect(parsePayload('{"choices":[{"delta":{"content":""}}]}')).toEqual({})
  })
  it('detects [DONE] and mid-stream errors', () => {
    expect(parsePayload('[DONE]')).toEqual({ done: true })
    expect(parsePayload('{"error":{"message":"rate limited"}}')).toEqual({ error: 'rate limited' })
  })
  it('tolerates garbage', () => {
    expect(parsePayload('not json')).toEqual({})
  })
})

// ---- end-to-end against a fake OpenAI-compatible server ----
let server: http.Server
let base = ''
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void

beforeEach(async () => {
  server = http.createServer((req, res) => handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

const collect = async (g: AsyncGenerator<StreamEvent>) => {
  let out = ''
  for await (const e of g) if (e.type === 'text') out += e.text
  return out
}
const events = async (g: AsyncGenerator<StreamEvent>) => {
  const all: StreamEvent[] = []
  for await (const e of g) all.push(e)
  return all
}

describe('streamChat', () => {
  it('streams tokens split across arbitrary chunk boundaries and sends auth', async () => {
    let auth = ''
    let body: any
    handler = (req, res) => {
      auth = req.headers.authorization ?? ''
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        body = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const stream =
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n'
        // write in awkward 7-byte slices to exercise buffering
        let i = 0
        const tick = () => {
          if (i >= stream.length) return res.end()
          res.write(stream.slice(i, i + 7))
          i += 7
          setTimeout(tick, 1)
        }
        tick()
      })
    }
    const out = await collect(
      streamChat({ baseUrl: base, apiKey: 'sk-test', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 })
    )
    expect(out).toBe('Hello, world')
    expect(auth).toBe('Bearer sk-test')
    expect(body).toMatchObject({ model: 'm', stream: true, temperature: 0.3 })
  })

  it('surfaces HTTP errors with the provider message', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"Invalid API key"}}')
    }
    await expect(collect(streamChat({ baseUrl: base, model: 'm', messages: [] }))).rejects.toThrow('401: Invalid API key')
  })

  it('gives a friendly error when the server is down', async () => {
    await expect(
      collect(streamChat({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', messages: [] }))
    ).rejects.toThrow(/Could not reach/)
  })

  it('aborts mid-stream via AbortSignal', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      // never ends
    }
    const ctl = new AbortController()
    const got: string[] = []
    const run = (async () => {
      for await (const t of streamChat({ baseUrl: base, model: 'm', messages: [], signal: ctl.signal })) {
        if (t.type === 'text') got.push(t.text)
        ctl.abort()
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(got).toEqual(['a'])
  })
})

describe('ToolCallAccumulator', () => {
  it('merges fragments by index', () => {
    const a = new ToolCallAccumulator()
    a.add([{ index: 0, id: 'c1', name: 'read_file', args: '{"pa' }])
    a.add([{ index: 0, args: 'th":"a.txt"}' }])
    a.add([{ index: 1, id: 'c2', name: 'list_dir', args: '{}' }])
    expect(a.result()).toEqual([
      { id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { id: 'c2', name: 'list_dir', arguments: '{}' }
    ])
  })
  it('handles providers that omit index and send whole calls', () => {
    const a = new ToolCallAccumulator()
    a.add([{ id: 'x', name: 'a', args: '{}' }])
    a.add([{ id: 'y', name: 'b', args: '{"k":1}' }])
    expect(a.result().map((c) => c.name)).toEqual(['a', 'b'])
  })
  it('synthesizes ids and default args when missing', () => {
    const a = new ToolCallAccumulator()
    a.add([{ index: 0, name: 'noargs' }])
    const [c] = a.result()
    expect(c.id).toMatch(/^call_/)
    expect(c.arguments).toBe('{}')
  })
})

describe('streamChat tool calls', () => {
  it('sends tool defs and yields assembled tool_calls after text', async () => {
    let body: any
    handler = (req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        body = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const d = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
        res.write(d({ content: 'Let me look. ' }))
        res.write(d({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] }))
        res.write(d({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }))
        res.write(d({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }))
        res.end('data: [DONE]\n\n')
      })
    }
    const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'd', parameters: {} } }]
    const evs = await events(streamChat({ baseUrl: base, model: 'm', messages: [], tools }))
    expect(body.tools).toEqual(tools)
    expect(evs).toEqual([
      { type: 'text', text: 'Let me look. ' },
      { type: 'tool_calls', calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] }
    ])
  })

  it('adds a hint when a 400 follows a request that included tools', async () => {
    handler = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"tools not supported"}}')
    }
    const tools = [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } }]
    await expect(events(streamChat({ baseUrl: base, model: 'm', messages: [], tools }))).rejects.toThrow(/turn tools off/)
  })
})

describe('fetchModels', () => {
  it('parses OpenAI-style and sorts', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"data":[{"id":"zeta"},{"id":"cc/alpha"}]}')
    }
    expect(await fetchModels(base)).toEqual(['cc/alpha', 'zeta'])
  })
})

describe('localhost fallback (Windows resolves localhost to IPv6 first; 9router listens on IPv4)', () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  let realFetch: typeof fetch
  let calls: string[]
  beforeEach(() => {
    realFetch = globalThis.fetch
    calls = []
    resetLoopbackCache()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  /** Fake network where only the given host answers. */
  const only = (host: string) => {
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      if (new URL(url).hostname !== host) throw refused()
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
    }) as typeof fetch
  }

  it('lists candidate addresses only for localhost', () => {
    expect(loopbackCandidates('http://localhost:20128/v1/models')).toEqual([
      'http://localhost:20128/v1/models', 'http://127.0.0.1:20128/v1/models', 'http://[::1]:20128/v1/models'
    ])
    expect(loopbackCandidates('http://127.0.0.1:20128/v1/models')).toEqual(['http://127.0.0.1:20128/v1/models'])
    expect(loopbackCandidates('https://api.example.com/v1/models')).toEqual(['https://api.example.com/v1/models'])
  })

  it('retries 127.0.0.1 when localhost is refused, and goes there first next time', async () => {
    only('127.0.0.1')
    expect(await fetchModels('http://localhost:20128/v1')).toEqual(['m1'])
    expect(calls).toEqual(['http://localhost:20128/v1/models', 'http://127.0.0.1:20128/v1/models'])
    calls = []
    expect(await fetchModels('http://localhost:20128/v1')).toEqual(['m1'])
    expect(calls).toEqual(['http://127.0.0.1:20128/v1/models'])
  })

  it('also tries [::1] for servers that listen on IPv6 only', async () => {
    only('[::1]')
    expect(await fetchModels('http://localhost:20128/v1')).toEqual(['m1'])
    expect(calls.at(-1)).toBe('http://[::1]:20128/v1/models')
  })

  it('applies to chat streaming too', async () => {
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      if (new URL(url).hostname !== '127.0.0.1') throw refused()
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    const out: StreamEvent[] = []
    for await (const ev of streamChat({ baseUrl: 'http://localhost:20128/v1', model: 'm', messages: [] })) out.push(ev)
    expect(out).toContainEqual({ type: 'text', text: 'hi' })
  })

  it('when nothing answers, says what was tried and what to check', async () => {
    only('nowhere')
    await expect(fetchModels('http://localhost:20128/v1')).rejects.toThrow(/Could not reach http:\/\/localhost:20128\/v1 \(also tried 127\.0\.0\.1 and \[::1\]\).*9router/)
    expect(calls).toHaveLength(3)
  })

  it('does not retry remote hosts or non-connection errors', async () => {
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      throw refused()
    }) as typeof fetch
    await expect(fetchModels('https://api.example.com/v1')).rejects.toThrow(/Could not reach https:\/\/api\.example\.com\/v1\. Is the server running\?$/)
    expect(calls).toHaveLength(1)
  })

  it('a 401 from a local server explains where the key goes', async () => {
    globalThis.fetch = (async (url: string) => {
      const r = new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
      Object.defineProperty(r, 'url', { value: url })
      return r
    }) as typeof fetch
    await expect(fetchModels('http://127.0.0.1:20128/v1')).rejects.toThrow(/401: Invalid API key\nThis server wants an API key: paste it in Settings → Providers → API key \(for 9router, copy the key from its dashboard\)/)
  })
})
