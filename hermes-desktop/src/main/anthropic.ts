import Anthropic from '@anthropic-ai/sdk'
import {
  ANTHROPIC_BASE_URL, ANTHROPIC_FALLBACK_BETA, fallbackEligible,
  type AnthropicOptions, type UsageInfo
} from '../shared/anthropic'
import { parseSlash, skillInvocation } from '../shared/skills'
import type { Message } from '../shared/types'
import type { ParsedToolCall, StreamEvent, ToolDef } from './openai'

/** Native Anthropic Messages API client (official SDK). No Electron imports: testable against a local fake server. */

export interface AnthropicStreamOptions {
  baseUrl: string
  apiKey?: string
  model: string
  system: string
  messages: Anthropic.MessageParam[]
  tools?: Anthropic.Tool[]
  options: AnthropicOptions
  signal?: AbortSignal
  /** Testing hook: treat the endpoint as fallback-capable regardless of its URL. */
  forceFallback?: boolean
}

const DEFAULT_MAX_TOKENS = 16_000
const CHAT_MAX_TOKENS = 64_000

export function makeClient(baseUrl: string | undefined, apiKey: string | undefined): Anthropic {
  return new Anthropic({ apiKey: apiKey || undefined, baseURL: (baseUrl || ANTHROPIC_BASE_URL).replace(/\/+$/, ''), maxRetries: 2 })
}

// ---------------------------------------------------------------- errors

/** Turn SDK errors into messages a person can act on. AbortErrors are re-thrown untouched. */
export function friendlyError(e: unknown, baseUrl: string): Error {
  if (e instanceof Anthropic.APIUserAbortError) {
    const a = new Error('Aborted')
    a.name = 'AbortError'
    return a
  }
  if (e instanceof Anthropic.AuthenticationError) return new Error('Authentication failed (401). Check the API key in Settings → Providers.')
  if (e instanceof Anthropic.PermissionDeniedError) return new Error(`Permission denied (403): ${e.message}`)
  if (e instanceof Anthropic.NotFoundError) return new Error(`Not found (404): ${e.message} — check the model name.`)
  if (e instanceof Anthropic.RateLimitError) return new Error('Rate limited (429). Wait a moment and try again.')
  if (e instanceof Anthropic.BadRequestError) return new Error(`The API rejected the request (400): ${e.message}`)
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new Error(`Timed out talking to ${baseUrl || ANTHROPIC_BASE_URL}.`)
  if (e instanceof Anthropic.APIConnectionError) return new Error(`Could not reach ${baseUrl || ANTHROPIC_BASE_URL}. Check your network connection.`)
  if (e instanceof Anthropic.APIError) {
    return new Error(e.status === 529 ? 'Anthropic is overloaded (529). Try again in a moment.' : `Anthropic API error${e.status ? ` (${e.status})` : ''}: ${e.message}`)
  }
  if (e instanceof Error && /authentication method|api key|apiKey/i.test(e.message)) {
    return new Error('No API key is set for this provider. Add one in Settings → Providers (or set ANTHROPIC_API_KEY).')
  }
  return e instanceof Error ? e : new Error(String(e))
}

// ---------------------------------------------------------------- models

interface ModelInfo {
  maxTokens?: number
  adaptive?: boolean
  effort?: boolean
}
const modelCache = new Map<string, ModelInfo>()

/** Real limits/capabilities from the Models API (cached); {} when it can't be reached — the main call then reports the actual problem. */
export async function modelInfo(client: Anthropic, baseUrl: string, model: string, signal?: AbortSignal): Promise<ModelInfo> {
  const key = `${baseUrl}|${model}`
  const hit = modelCache.get(key)
  if (hit) return hit
  try {
    const m: any = await client.models.retrieve(model, undefined, { signal })
    const info: ModelInfo = {
      maxTokens: typeof m.max_tokens === 'number' ? m.max_tokens : undefined,
      adaptive: m.capabilities?.thinking?.types?.adaptive?.supported,
      effort: m.capabilities?.effort?.supported
    }
    modelCache.set(key, info)
    return info
  } catch {
    return {}
  }
}
export const clearModelCache = () => modelCache.clear()

/** Model ids in the API's own order (newest first) — not alphabetical. */
export async function listClaudeModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const client = makeClient(baseUrl, apiKey)
  const ids: string[] = []
  try {
    for await (const m of client.models.list({ limit: 100 })) {
      ids.push(m.id)
      if (ids.length >= 200) break
    }
  } catch (e) {
    throw friendlyError(e, baseUrl)
  }
  return ids
}

// ---------------------------------------------------------------- messages

const safeJson = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function toAnthropicTools(defs: ToolDef[]): Anthropic.Tool[] {
  return defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    input_schema: d.function.parameters as Anthropic.Tool.InputSchema
  }))
}

/**
 * Stored conversation → Messages API history.
 *  - assistant turns replay the provider's *original* content blocks (`raw`) verbatim: thinking blocks carry
 *    signatures and the API checks that earlier turns weren't edited;
 *  - tool results go in ONE user message right after the tool_use turn;
 *  - consecutive user messages are merged (tool_results first).
 */
export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  const asBlocks = (c: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c)
  const push = (role: 'user' | 'assistant', content: Anthropic.MessageParam['content']) => {
    const last = out.at(-1)
    if (role === 'user' && last?.role === 'user') last.content = [...asBlocks(last.content), ...asBlocks(content)]
    else out.push({ role, content })
  }

  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.skill ? skillInvocation(m.skill.name, m.skill.text, parseSlash(m.content)?.args ?? '') : m.content
      if (text.trim()) push('user', text)
      continue
    }
    if (m.role !== 'assistant') continue
    const calls = m.toolCalls ?? []
    if (!calls.length && (m.error || !m.content)) continue // failed/partial/empty turns aren't replayed

    const blocks: Anthropic.ContentBlockParam[] = m.raw?.length
      ? (m.raw as Anthropic.ContentBlockParam[])
      : [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: safeJson(c.arguments) }))
        ]
    if (!blocks.length) continue
    push('assistant', blocks)
    if (calls.length) {
      push(
        'user',
        calls.map((c): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: c.id,
          content: c.result ?? 'Interrupted before completion.',
          ...(c.status === 'error' || c.status === 'denied' ? { is_error: true } : {})
        }))
      )
    }
  }
  return out
}

// ---------------------------------------------------------------- streaming

/** Streams one assistant turn: text/thinking deltas, then `meta`, then (if the model asked for tools) `tool_calls`. */
export async function* streamAnthropic(o: AnthropicStreamOptions): AsyncGenerator<StreamEvent> {
  const client = makeClient(o.baseUrl, o.apiKey)
  const info = await modelInfo(client, o.baseUrl, o.model, o.signal)
  const maxTokens = Math.min(CHAT_MAX_TOKENS, info.maxTokens ?? DEFAULT_MAX_TOKENS)

  // NB: no `temperature`/`top_p`/`top_k` — newer Claude models reject them.
  const params: Record<string, unknown> = { model: o.model, max_tokens: maxTokens, system: o.system, messages: o.messages }
  if (o.tools?.length) params.tools = o.tools
  if (o.options.promptCaching) params.cache_control = { type: 'ephemeral' }
  if (o.options.showThinking && info.adaptive !== false) params.thinking = { type: 'adaptive', display: 'summarized' }
  if (o.options.effort && info.effort !== false) params.output_config = { effort: o.options.effort }

  let emitted = false
  async function* run(useFallback: boolean): AsyncGenerator<StreamEvent> {
    const stream: any = useFallback
      ? client.beta.messages.stream({ ...(params as any), betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' }, { signal: o.signal })
      : client.messages.stream(params as any, { signal: o.signal })
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type !== 'content_block_delta') continue
      if (ev.delta.type === 'text_delta' && ev.delta.text) {
        emitted = true
        yield { type: 'text', text: ev.delta.text }
      } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
        emitted = true
        yield { type: 'thinking', text: ev.delta.thinking }
      }
    }
    const final: any = await stream.finalMessage()
    const blocks: any[] = final.content ?? []
    const u = final.usage ?? {}
    const usage: UsageInfo = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens || undefined, cacheWrite: u.cache_creation_input_tokens || undefined }
    const fellBack = blocks.some((b) => b.type === 'fallback') || (u.iterations ?? []).some((i: any) => i.type === 'fallback_message')
    const toolUses = blocks.filter((b) => b.type === 'tool_use')
    const stop: string = final.stop_reason

    if (stop === 'model_context_window_exceeded') throw new Error("This conversation no longer fits in the model's context window. Start a new chat.")
    if (stop === 'max_tokens' && toolUses.length) {
      throw new Error('The response hit the output limit while writing a tool call, so the call was not run. Try again, or ask for a smaller step.')
    }

    yield {
      type: 'meta',
      meta: {
        raw: stop === 'refusal' ? undefined : blocks,
        usage,
        servedBy: fellBack ? final.model : undefined,
        refusal: stop === 'refusal' ? { category: final.stop_details?.category ?? null, explanation: final.stop_details?.explanation ?? null } : undefined
      }
    }
    if (toolUses.length && stop !== 'refusal') {
      const calls: ParsedToolCall[] = toolUses.map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }))
      yield { type: 'tool_calls', calls }
    }
  }

  const wantFallback = o.options.refusalFallback && (o.forceFallback || fallbackEligible(o.model, o.baseUrl))
  try {
    try {
      yield* run(wantFallback)
    } catch (e) {
      // Safety net: if an account/model rejects the fallback beta, retry once without it (only if nothing was streamed yet).
      if (wantFallback && !emitted && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) yield* run(false)
      else throw e
    }
  } catch (e) {
    throw friendlyError(e, o.baseUrl)
  }
}
