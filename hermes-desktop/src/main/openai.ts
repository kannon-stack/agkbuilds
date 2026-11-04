// Minimal OpenAI-compatible client (chat/completions streaming + /models).
// No Electron imports so it can be unit-tested in plain Node.

export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamOptions {
  baseUrl: string
  apiKey?: string
  model: string
  messages: WireMessage[]
  temperature?: number
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

export type Parsed = { text?: string; done?: boolean; error?: string }

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
  const text: unknown = choice?.delta?.content ?? choice?.text
  return typeof text === 'string' && text ? { text } : {}
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

/** Yields content deltas as they arrive. Throws on HTTP/provider errors. */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
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
          stream: true
        })
      },
      opts.connectTimeoutMs ?? 30_000,
      opts.signal
    )
  } catch (e) {
    throw networkError(baseUrl, e)
  }
  if (!res.ok) throw new Error(await errorFromResponse(res))
  if (!res.body) throw new Error('Provider returned an empty response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const { payloads, rest } = splitSSE(buf)
      buf = rest
      for (const p of payloads) {
        const r = parsePayload(p)
        if (r.error) throw new Error(r.error)
        if (r.text) yield r.text
        if (r.done) return
      }
    }
    // flush a final unterminated event
    const { payloads } = splitSSE(buf + '\n\n')
    for (const p of payloads) {
      const r = parsePayload(p)
      if (r.error) throw new Error(r.error)
      if (r.text) yield r.text
    }
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
