// Minimal OpenAI-compatible client (chat/completions streaming + /models).
// No Electron imports so it can be unit-tested in plain Node.

import type { RefusalInfo, UsageInfo } from '../shared/anthropic'

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ParsedToolCall {
  id: string
  name: string
  arguments: string
}

export interface StreamMeta {
  /** Provider-native content blocks of the finished response (for verbatim replay). */
  raw?: unknown[]
  usage?: UsageInfo
  servedBy?: string
  refusal?: RefusalInfo
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'meta'; meta: StreamMeta }
  | { type: 'tool_calls'; calls: ParsedToolCall[] }

export interface StreamOptions {
  baseUrl: string
  apiKey?: string
  model: string
  messages: WireMessage[]
  temperature?: number
  tools?: ToolDef[]
  signal?: AbortSignal
  /** ms to wait for response headers before giving up. */
  connectTimeoutMs?: number
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '')

const headers = (apiKey?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
})

/** Split an SSE buffer into complete `data:` payloads + the unfinished tail. */
export function splitSSE(buffer: string): { payloads: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const payloads: string[] = []
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) payloads.push(data)
  }
  return { payloads, rest }
}

export interface ToolDelta {
  index?: number
  id?: string
  name?: string
  args?: string
}
export type Parsed = { text?: string; toolDeltas?: ToolDelta[]; done?: boolean; error?: string }

/** Interpret one SSE `data:` payload from a chat.completions stream. */
export function parsePayload(data: string): Parsed {
  if (data.trim() === '[DONE]') return { done: true }
  let json: any
  try {
    json = JSON.parse(data)
  } catch {
    return {}
  }
  if (json?.error) {
    return { error: typeof json.error === 'string' ? json.error : json.error.message ?? 'Provider error' }
  }
  const choice = json?.choices?.[0]
  const out: Parsed = {}
  const text: unknown = choice?.delta?.content ?? choice?.text
  if (typeof text === 'string' && text) out.text = text
  const tcs: any[] | undefined = choice?.delta?.tool_calls
  if (Array.isArray(tcs) && tcs.length) {
    out.toolDeltas = tcs.map((t) => ({
      index: typeof t.index === 'number' ? t.index : undefined,
      id: typeof t.id === 'string' && t.id ? t.id : undefined,
      name: typeof t.function?.name === 'string' && t.function.name ? t.function.name : undefined,
      args: typeof t.function?.arguments === 'string' ? t.function.arguments : undefined
    }))
  }
  return out
}

/** Reassembles fragmented streamed tool calls into complete ones. */
export class ToolCallAccumulator {
  private calls: { id?: string; name: string; args: string }[] = []
  private lastIndex = -1

  add(deltas: ToolDelta[]) {
    for (const d of deltas) {
      // Providers differ: most send `index`; a few omit it and send a fresh `id` per call.
      let i = d.index ?? (d.id && d.name ? this.calls.length : Math.max(this.lastIndex, 0))
      if (d.index === undefined && d.id && this.calls.some((c) => c.id === d.id)) {
        i = this.calls.findIndex((c) => c.id === d.id)
      }
      this.lastIndex = i
      const c = (this.calls[i] ??= { name: '', args: '' })
      if (d.id) c.id = d.id
      if (d.name) c.name = c.name ? c.name + d.name : d.name
      if (d.args) c.args += d.args
    }
  }

  result(): ParsedToolCall[] {
    return this.calls
      .filter((c) => c && c.name)
      .map((c, i) => ({ id: c.id ?? `call_${Date.now().toString(36)}_${i}`, name: c.name, arguments: c.args || '{}' }))
  }
}

async function errorFromResponse(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  try {
    const j = JSON.parse(body)
    const msg = j?.error?.message ?? j?.error ?? j?.message
    if (msg) return `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`
}

function networkError(baseUrl: string, e: unknown): Error {
  const err = e as Error & { cause?: { code?: string } }
  if (err?.name === 'AbortError') return err
  const code = err?.cause?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || err?.message === 'fetch failed') {
    return new Error(`Could not reach ${baseUrl}. Is the server running?`)
  }
  return err instanceof Error ? err : new Error(String(e))
}

/**
 * Fetch with a header-arrival timeout. The caller's signal stays linked to the
 * request for the *entire* lifetime (including the streaming body) so Stop works
 * mid-stream; only the connect timer is cleared once headers arrive.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number, signal?: AbortSignal) {
  const ctl = new AbortController()
  if (signal?.aborted) ctl.abort()
  else signal?.addEventListener('abort', () => ctl.abort(), { once: true })
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } catch (e) {
    if (ctl.signal.reason instanceof Error && ctl.signal.reason.message === 'timeout') {
      throw new Error(`Timed out connecting to ${url}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Yields text deltas, then (if the model asked for tools) one `tool_calls` event. */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<StreamEvent> {
  const baseUrl = trimUrl(opts.baseUrl)
  let res: Response
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: headers(opts.apiKey),
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature,
          stream: true,
          ...(opts.tools?.length ? { tools: opts.tools } : {})
        })
      },
      opts.connectTimeoutMs ?? 30_000,
      opts.signal
    )
  } catch (e) {
    throw networkError(baseUrl, e)
  }
  if (!res.ok) {
    const msg = await errorFromResponse(res)
    const hint =
      opts.tools?.length && (res.status === 400 || res.status === 422)
        ? "\n(If this model doesn't support tool calling, turn tools off in Settings → Tools.)"
        : ''
    throw new Error(msg + hint)
  }
  if (!res.body) throw new Error('Provider returned an empty response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const acc = new ToolCallAccumulator()
  let buf = ''
  let finished = false

  function* handle(payloads: string[]): Generator<StreamEvent> {
    for (const p of payloads) {
      const r = parsePayload(p)
      if (r.error) throw new Error(r.error)
      if (r.text) yield { type: 'text', text: r.text }
      if (r.toolDeltas) acc.add(r.toolDeltas)
      if (r.done) {
        finished = true
        return
      }
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const { payloads, rest } = splitSSE(buf)
      buf = rest
      yield* handle(payloads)
    }
    if (!finished) yield* handle(splitSSE(buf + '\n\n').payloads) // flush unterminated final event
    const calls = acc.result()
    if (calls.length) yield { type: 'tool_calls', calls }
  } catch (e) {
    throw networkError(baseUrl, e)
  } finally {
    reader.cancel().catch(() => {})
  }
}

export async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = trimUrl(baseUrl)
  let res: Response
  try {
    res = await fetchWithTimeout(`${url}/models`, { headers: headers(apiKey) }, 10_000)
  } catch (e) {
    throw networkError(url, e)
  }
  if (!res.ok) throw new Error(await errorFromResponse(res))
  const j: any = await res.json()
  const list: any[] = Array.isArray(j) ? j : j?.data ?? j?.models ?? []
  return list
    .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name))
    .filter((id): id is string => typeof id === 'string')
    .sort((a, b) => a.localeCompare(b))
}
