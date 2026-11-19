import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  IMAGE_TOKENS, MIN_WINDOW, autoCompactAt, chooseBoundary, chunkTranscripts, cleanContext, contextUsage, estimateMessage, estimateText, fitToWindow, inputBudget,
  liveRegion, parseOverflow, summaryBlock, summaryRequest, transcriptFor, trimOldMessages, windowFor, windowFromName, DEFAULT_CONTEXT
} from '../src/shared/context'
import { summarize } from '../src/main/summarize'
import type { Message } from '../src/shared/types'

let n = 0
const msg = (role: Message['role'], content: string, over: Partial<Message> = {}): Message => ({ id: `m${n++}`, role, content, createdAt: n, ...over })
const turn = (q: string, a: string, over: Partial<Message> = {}) => [msg('user', q), msg('assistant', a, over)]
const conv = (turns: number, size = 40) => Array.from({ length: turns }, (_, i) => turn(`q${i} ${'x'.repeat(size)}`, `a${i} ${'y'.repeat(size)}`)).flat()

describe('estimateText', () => {
  it('scales with length and counts CJK per character', () => {
    expect(estimateText('')).toBe(0)
    expect(estimateText('a'.repeat(360))).toBe(100)
    expect(estimateText('你好世界')).toBe(4)
    expect(estimateText('a'.repeat(36) + '你好')).toBe(12)
  })
  it('prices messages: text, tool calls, results, images', () => {
    const base = estimateMessage(msg('user', 'hi'))
    const withImg = estimateMessage(msg('user', 'hi', { attachments: [{ id: 'a'.repeat(64), name: 'x', mime: 'image/png', size: 1 }] }))
    expect(withImg - base).toBe(IMAGE_TOKENS)
    const tool = estimateMessage(msg('assistant', '', { toolCalls: [{ id: 't', name: 'read_file', arguments: '{"path":"a"}', status: 'done', result: 'z'.repeat(3600) }] }))
    expect(tool).toBeGreaterThan(1000)
  })
})

describe('context window', () => {
  it.each([
    ['cc/claude-opus-4-7', 200_000], ['claude-sonnet-4-5[1m]', 1_000_000], ['gc/gemini-3-pro', 1_000_000], ['cx/gpt-5.5', 400_000],
    ['gpt-4o-mini', 128_000], ['gpt-4', 8_192], ['gpt-4.1', 1_000_000], ['o3-mini', 200_000], ['llama3:8b', 8_192], ['llama-3.1-70b', 128_000],
    ['qwen2.5-coder', 32_768], ['deepseek-chat', 128_000]
  ])('guesses %s', (name, tokens) => expect(windowFromName(name)).toBe(tokens))

  it('does not mistake unrelated names for o-series models', () => {
    expect(windowFromName('foo-mo1-bar')).toBeUndefined()
    expect(windowFromName('totally-unknown')).toBeUndefined()
  })

  it('prefers setting > learned > provider > name > default', () => {
    expect(windowFor('gpt-4', { setting: 50_000, learned: 1, provider: 2 })).toEqual({ tokens: 50_000, source: 'setting' })
    expect(windowFor('gpt-4', { learned: 6000, provider: 2 })).toEqual({ tokens: 6000, source: 'learned' })
    expect(windowFor('gpt-4', { provider: 9999 })).toEqual({ tokens: 9999, source: 'provider' })
    expect(windowFor('claude-x')).toEqual({ tokens: 200_000, source: 'model' })
    expect(windowFor('mystery')).toEqual({ tokens: 128_000, source: 'default' })
  })

  it('keeps room for the reply', () => {
    expect(inputBudget(200_000)).toBeLessThan(200_000 * 0.95)
    expect(inputBudget(100)).toBe(1000)
  })
})

describe('parseOverflow', () => {
  it.each([
    ["This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", 8192],
    ['prompt is too long: 250000 tokens > 200000 maximum', undefined],
    ['context_length_exceeded', undefined],
    ['400: Request too large for model', undefined],
    ['Input is too long for requested model.', undefined],
    ['the maximum context length is 1,048,576 tokens', 1048576]
  ])('detects "%s"', (text, limit) => {
    const r = parseOverflow(text)
    expect(r.overflow).toBe(true)
    expect(r.limit).toBe(limit)
  })
  it('ignores unrelated errors', () => {
    expect(parseOverflow('401: invalid api key').overflow).toBe(false)
    expect(parseOverflow('Could not reach http://localhost:20128').overflow).toBe(false)
    expect(parseOverflow('rate limit exceeded').overflow).toBe(false)
  })
  it('ignores absurd limits', () => expect(parseOverflow('maximum context length is 12 tokens').limit).toBeUndefined())
})

describe('cleanContext', () => {
  it('clamps and defaults', () => {
    expect(cleanContext(undefined)).toEqual(DEFAULT_CONTEXT)
    expect(cleanContext({ threshold: 5, window: 10 })).toEqual({ auto: true, threshold: 0.95, window: MIN_WINDOW })
    expect(cleanContext({ threshold: 0.1, window: -5, auto: false })).toEqual({ auto: false, threshold: 0.5, window: 0 })
    expect(cleanContext({ threshold: 'x', window: NaN, auto: 'yes' })).toEqual(DEFAULT_CONTEXT)
    expect(cleanContext({ window: 1e12 }).window).toBe(10_000_000)
  })
})

describe('chooseBoundary / liveRegion', () => {
  it('needs at least two turns', () => {
    expect(chooseBoundary(conv(1), 1)).toBeNull()
    expect(chooseBoundary([], 2)).toBeNull()
  })

  it('cuts right before the kept user turns', () => {
    const p = conv(5)
    const b = chooseBoundary(p, 2)!
    expect(b.node).toBe(p[5]) // last message of turn 3 (index 5)
    expect(b.messages).toHaveLength(6)
    expect(p[6].role).toBe('user') // the kept tail starts at a user message
  })

  it('keeps at least one turn even if asked to keep more than exist', () => {
    const p = conv(2)
    const b = chooseBoundary(p, 5)!
    expect(b.messages).toHaveLength(2)
    expect(b.node).toBe(p[1])
  })

  it('never splits a tool round from its results (cuts before user messages only)', () => {
    const p = [
      msg('user', 'q1'), msg('assistant', '', { toolCalls: [{ id: 't', name: 'x', arguments: '{}', status: 'done', result: 'r' }] }), msg('assistant', 'done'),
      msg('user', 'q2'), msg('assistant', 'a2')
    ]
    const b = chooseBoundary(p, 1)!
    expect(b.node).toBe(p[2])
    expect(b.messages).toHaveLength(3)
  })

  it('later compactions start after the earlier one and fold it in', () => {
    const p = conv(6)
    p[3].compaction = { text: 'old summary', createdAt: 1, auto: true, messages: 4, tokensBefore: 10, tokensAfter: 5 }
    const live = liveRegion(p)
    expect(live.at).toBe(3)
    expect(live.messages).toHaveLength(8)
    const b = chooseBoundary(p, 1)!
    expect(b.previous?.text).toBe('old summary')
    expect(b.messages[0]).toBe(p[4])
    expect(b.node).toBe(p[9])
    // nothing new to summarize when the live part is a single turn
    expect(chooseBoundary(p.slice(0, 6), 1)).toBeNull()
  })
})

describe('trimOldMessages', () => {
  const big = 'r'.repeat(5000)
  const call = (result: string) => ({ id: 't', name: 'x', arguments: '{}', status: 'done' as const, result })
  it('shortens old tool results and images but not the recent turns; never mutates', () => {
    const att = { id: 'a'.repeat(64), name: 'cat.png', mime: 'image/png' as const, size: 1 }
    const p = [
      msg('user', 'old', { attachments: [att] }), msg('assistant', '', { toolCalls: [call(big)] }),
      msg('user', 'mid'), msg('assistant', 'a'),
      msg('user', 'new'), msg('assistant', '', { toolCalls: [call(big)] })
    ]
    const out = trimOldMessages(p, 2)
    expect(out[1].toolCalls![0].result!.length).toBeLessThan(1000)
    expect(out[1].toolCalls![0].result).toContain('omitted to save context')
    expect(out[0].attachments).toBeUndefined()
    expect(out[0].content).toContain('[image omitted to save context: cat.png]')
    expect(out[5].toolCalls![0].result).toBe(big) // recent: untouched
    expect(p[1].toolCalls![0].result).toBe(big) // original intact
    expect(p[0].attachments).toHaveLength(1)
  })
})

describe('fitToWindow', () => {
  it('passes everything through when it fits', () => {
    const p = conv(3)
    const f = fitToWindow(p, { budget: 100_000, overhead: 100 })
    expect(f.messages).toHaveLength(6)
    expect(f).toMatchObject({ trimmed: false, dropped: 0 })
  })

  it('starts after the latest compaction and reports the summary', () => {
    const p = conv(4)
    p[3].compaction = { text: 'S', createdAt: 1, auto: false, messages: 4, tokensBefore: 1, tokensAfter: 1 }
    const f = fitToWindow(p, { budget: 100_000, overhead: 0 })
    expect(f.summary).toBe('S')
    expect(f.messages).toEqual(p.slice(4))
  })

  it('trims first, then drops whole oldest turns, always keeping the newest', () => {
    const p = conv(10, 400)
    const total = p.reduce((s, m) => s + estimateMessage(m), 0)
    const f = fitToWindow(p, { budget: Math.floor(total / 2), overhead: 0 })
    expect(f.trimmed).toBe(true)
    expect(f.dropped).toBeGreaterThan(0)
    expect(f.messages[0].role).toBe('user')
    expect(f.messages.at(-1)).toBe(p.at(-1))
    expect(f.estimate).toBeLessThanOrEqual(Math.floor(total / 2))
    expect(f.messages.length + f.dropped).toBe(p.length)
  })

  it('keeps the last turn even when it alone exceeds the budget', () => {
    const p = conv(3, 4000)
    const f = fitToWindow(p, { budget: 10, overhead: 0 })
    expect(f.messages).toHaveLength(2)
    expect(f.messages[0]).toBe(p[4])
  })
})

describe('contextUsage', () => {
  const settings = DEFAULT_CONTEXT
  const win = { tokens: 100_000, source: 'model' as const }
  it('estimates when no usage is known', () => {
    const u = contextUsage(conv(3), { systemTokens: 100, toolTokens: 50, window: win, settings })
    expect(u.source).toBe('estimated')
    expect(u.used).toBe(100 + 50 + u.parts.messages)
    expect(u.autoAt).toBe(80_000)
    expect(autoCompactAt(8192, DEFAULT_CONTEXT)).toBe(inputBudget(8192)) // small windows: never above the send budget
    expect(u.canCompact).toBe(true)
  })

  it('anchors on the provider’s count from the last answer and adds what came after', () => {
    const p = conv(3)
    p[3].usage = { input: 5000, output: 200, cacheRead: 1000 }
    const u = contextUsage(p, { systemTokens: 100, toolTokens: 50, window: win, settings })
    expect(u.source).toBe('reported')
    expect(u.used).toBe(5000 + 1000 + 200 + estimateMessage(p[4]) + estimateMessage(p[5]))
  })

  it('ignores usage from before the latest compaction', () => {
    const p = conv(4)
    p[1].usage = { input: 99_000, output: 1 }
    p[3].compaction = { text: 'S', createdAt: 1, auto: true, messages: 4, tokensBefore: 1, tokensAfter: 1 }
    const u = contextUsage(p, { systemTokens: 0, toolTokens: 0, window: win, settings })
    expect(u.source).toBe('estimated')
    expect(u.used).toBeLessThan(2000)
    expect(u.compactions).toBe(1)
  })

  it('autoAt is 0 when auto-compaction is off', () => {
    expect(contextUsage(conv(2), { systemTokens: 0, toolTokens: 0, window: win, settings: { ...settings, auto: false } }).autoAt).toBe(0)
  })
})

describe('summary prompts', () => {
  it('transcripts skip reasoning/errors, mark images and tool calls, and clip long text', () => {
    const p = [
      msg('user', 'hello', { attachments: [{ id: 'a'.repeat(64), name: 'cat.png', mime: 'image/png', size: 1 }] }),
      msg('assistant', 'hi', { thinking: 'SECRET', toolCalls: [{ id: 't', name: 'read_file', arguments: '{}', status: 'done', summary: 'read a.txt', result: 'z'.repeat(2000) }] }),
      msg('assistant', '', { error: 'boom' }),
      msg('user', 'x'.repeat(20_000))
    ]
    const t = transcriptFor(p)
    expect(t).toContain('User: [image: cat.png]\nhello')
    expect(t).toContain('[tool read_file — read a.txt → ')
    expect(t).not.toContain('SECRET')
    expect(t).not.toContain('boom')
    expect(t).toContain('more characters]')
    expect(t.length).toBeLessThan(9000)
  })

  it('chunks so every piece fits the limit', () => {
    const chunks = chunkTranscripts(conv(30, 2000), 3000)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(estimateText(c)).toBeLessThan(3000 + 2600)
    expect(chunkTranscripts([], 1000)).toEqual([])
  })

  it('requests fold in the previous summary and extra instructions', () => {
    const r = summaryRequest({ transcript: 'T', previous: 'P', instructions: 'focus on bugs' })
    expect(r).toContain('<previous_summary>\nP\n</previous_summary>')
    expect(r).toContain('updated summary')
    expect(r).toContain('focus on bugs')
    expect(summaryRequest({ transcript: 'T' })).not.toContain('previous_summary')
    expect(summaryBlock('abc')).toContain('abc')
  })
})

describe('summarize (against a fake OpenAI-compatible server)', () => {
  let server: http.Server
  let url = ''
  let bodies: any[] = []
  let reply = (_b: any) => 'SUMMARY'
  beforeEach(async () => {
    bodies = []
    reply = () => 'SUMMARY'
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const b = JSON.parse(raw)
        bodies.push(b)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply(b) } }] }) + '\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  const base = () => ({ kind: 'openai' as const, baseUrl: url, model: 'm', window: 128_000 })

  it('sends one request with the transcript and returns the text', async () => {
    const out = await summarize({ ...base(), messages: conv(2), instructions: 'be brief' })
    expect(out).toBe('SUMMARY')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].tools).toBeUndefined()
    expect(bodies[0].messages[0].role).toBe('system')
    expect(bodies[0].messages[1].content).toContain('User: q0')
    expect(bodies[0].messages[1].content).toContain('be brief')
  })

  it('folds a previous summary in', async () => {
    await summarize({ ...base(), messages: conv(2), previous: 'EARLIER' })
    expect(bodies[0].messages[1].content).toContain('EARLIER')
  })

  it('summarizes huge histories in several passes, each folding in the last result', async () => {
    let i = 0
    reply = () => `S${++i}`
    const out = await summarize({ ...base(), window: 6000, messages: conv(40, 3000) })
    expect(bodies.length).toBeGreaterThan(2)
    expect(out).toBe(`S${bodies.length}`)
    expect(bodies[1].messages[1].content).toContain('S1')
    expect(bodies.at(-1).messages[1].content).toContain(`S${bodies.length - 1}`)
  })

  it('fails clearly on an empty summary or nothing to summarize', async () => {
    reply = () => '   '
    await expect(summarize({ ...base(), messages: conv(2) })).rejects.toThrow(/empty summary/)
    await expect(summarize({ ...base(), messages: [] })).rejects.toThrow(/Nothing to summarize/)
  })

  it('propagates provider errors', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await expect(summarize({ ...base(), baseUrl: 'http://127.0.0.1:1/v1', messages: conv(2) })).rejects.toThrow()
    server = http.createServer().listen(0) // so afterEach can close
  })
})
