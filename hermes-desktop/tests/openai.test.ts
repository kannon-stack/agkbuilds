import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchModels, parsePayload, splitSSE, streamChat } from '../src/main/openai'

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

const collect = async (g: AsyncGenerator<string>) => {
  let out = ''
  for await (const t of g) out += t
  return out
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
        got.push(t)
        ctl.abort()
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(got).toEqual(['a'])
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
