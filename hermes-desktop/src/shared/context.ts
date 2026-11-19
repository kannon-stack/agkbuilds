// Context-window management: token estimates, window detection, compaction (summary) boundaries, and fitting a
// conversation into the model's input budget. Pure (no I/O) so it's unit-testable.
import { pathOf } from './tree'
import type { Compaction, Message } from './types'

// ---------------------------------------------------------------- settings

export interface ContextSettings {
  /** Summarize older turns automatically when the conversation nears the window. */
  auto: boolean
  /** Fraction of the window at which auto-summarizing kicks in (0.5–0.95). */
  threshold: number
  /** Context window in tokens; 0 = detect from the provider / model name. */
  window: number
}

export const DEFAULT_CONTEXT: ContextSettings = { auto: true, threshold: 0.8, window: 0 }
export const MIN_WINDOW = 2048
export const MAX_WINDOW = 10_000_000

export function cleanContext(raw: unknown, base: ContextSettings = DEFAULT_CONTEXT): ContextSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ContextSettings>
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const win = Math.round(num(r.window, base.window))
  return {
    auto: typeof r.auto === 'boolean' ? r.auto : base.auto,
    threshold: Math.min(0.95, Math.max(0.5, num(r.threshold, base.threshold))),
    window: win <= 0 ? 0 : Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, win))
  }
}

// ---------------------------------------------------------------- estimation

/** Rough but consistent: ~3.6 chars/token for Latin text and code, 1 token per CJK/emoji-range char. */
export function estimateText(s: string): number {
  if (!s) return 0
  let wide = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x2e80) wide++
  return Math.ceil((s.length - wide) / 3.6) + wide
}

/** Images are priced flat; real cost depends on dimensions, but they're downscaled to ≤2048px before sending. */
export const IMAGE_TOKENS = 1200
const MESSAGE_OVERHEAD = 4

export function estimateMessage(m: Message): number {
  let n = MESSAGE_OVERHEAD + estimateText(m.content)
  if (m.skill) n += estimateText(m.skill.text)
  n += (m.attachments?.length ?? 0) * IMAGE_TOKENS
  for (const c of m.toolCalls ?? []) n += 12 + estimateText(c.name) + estimateText(c.arguments) + estimateText(c.result ?? '')
  return n
}

export const estimateMessages = (ms: readonly Message[]) => ms.reduce((s, m) => s + estimateMessage(m), 0)

// ---------------------------------------------------------------- window

export type WindowSource = 'setting' | 'learned' | 'provider' | 'model' | 'default'
export interface WindowInfo {
  tokens: number
  source: WindowSource
}

export const DEFAULT_WINDOW = 128_000

// First match wins. Names are matched case-insensitively anywhere in the id, so router prefixes ("cc/", "openrouter/…") are fine.
const NAME_WINDOWS: [RegExp, number][] = [
  [/(\[1m\]|[-_:]1m\b|1m-context)/, 1_000_000],
  [/gemini/, 1_000_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-5/, 400_000],
  [/gpt-4o|gpt-4-turbo|gpt-4\.5/, 128_000],
  [/gpt-4-32k/, 32_768],
  [/gpt-4\b/, 8_192],
  [/gpt-3\.5/, 16_385],
  [/(^|[^a-z])o[134](-|$|[^a-z])/, 200_000],
  [/claude/, 200_000],
  [/llama-?3\.[1-9]|llama-?4|llama3\.[1-9]/, 128_000],
  [/llama-?3\b|llama3\b|llama-?2/, 8_192],
  [/deepseek/, 128_000],
  [/mistral-large|mistral-nemo|mixtral-8x22b/, 128_000],
  [/mistral|mixtral/, 32_768],
  [/qwen/, 32_768],
  [/gemma/, 8_192],
  [/command-r/, 128_000]
]

export function windowFromName(model: string): number | undefined {
  const id = model.toLowerCase()
  return NAME_WINDOWS.find(([re]) => re.test(id))?.[1]
}

/** setting > learned from an overflow error > what the provider reports > guess from the model name > 128k. */
export function windowFor(model: string, opts: { setting?: number; learned?: number; provider?: number } = {}): WindowInfo {
  if (opts.setting && opts.setting > 0) return { tokens: opts.setting, source: 'setting' }
  if (opts.learned && opts.learned > 0) return { tokens: opts.learned, source: 'learned' }
  if (opts.provider && opts.provider > 0) return { tokens: opts.provider, source: 'provider' }
  const byName = windowFromName(model)
  return byName ? { tokens: byName, source: 'model' } : { tokens: DEFAULT_WINDOW, source: 'default' }
}

/** Largest input we'll send: leaves room for the reply and absorbs estimation error. */
export const inputBudget = (window: number) => Math.max(1000, Math.floor(window * 0.95) - 4096)

/** Token count at which automatic summarizing starts: the chosen fraction of the window, but never above what we'd send anyway. */
export const autoCompactAt = (window: number, s: ContextSettings) => Math.min(Math.floor(window * s.threshold), inputBudget(window))

/** Recognise "your prompt is too long" errors from OpenAI-compatible servers and Claude, and pull out the limit if stated. */
export function parseOverflow(message: string): { overflow: boolean; limit?: number } {
  const m = message.toLowerCase()
  const overflow =
    /context[ _-]?(length|window|limit)|maximum context|prompt is too long|too many tokens|input is too long|exceeds? (the )?(model'?s? )?(maximum|max|limit|context)|reduce the length|token limit|max_prompt_tokens|request too large/.test(m)
  if (!overflow) return { overflow: false }
  const limit = /(?:maximum context length|context (?:length|window|limit)|max(?:imum)?[_ ](?:prompt|input|context)[_ ]tokens?)[^\d]{0,40}?(\d[\d,]{3,})/.exec(m)?.[1]
  const n = limit ? Number(limit.replace(/,/g, '')) : NaN
  return { overflow: true, ...(n >= MIN_WINDOW && n <= MAX_WINDOW ? { limit: n } : {}) }
}

// ---------------------------------------------------------------- compaction (summaries)

/** Summarized prefix: the last message on the path that carries a compaction replaces everything up to and including itself. */
export interface LiveRegion {
  compaction?: Compaction
  /** Index (in the path) of the message holding the compaction, or -1. */
  at: number
  messages: Message[]
}

export function liveRegion(path: readonly Message[]): LiveRegion {
  let at = -1
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].compaction) {
      at = i
      break
    }
  }
  return { compaction: at >= 0 ? path[at].compaction : undefined, at, messages: path.slice(at + 1) }
}

export const KEEP_TURNS_AUTO = 2
export const KEEP_TURNS_MANUAL = 1

export interface Boundary {
  /** The message to attach the new compaction to (everything up to it gets summarized). */
  node: Message
  /** What to summarize (after any earlier compaction, up to `node`). */
  messages: Message[]
  previous?: Compaction
}

/**
 * Where to cut: right before one of the last `keep` user turns, so the kept tail always starts with a user message
 * and tool calls never get separated from their results. null = nothing worth summarizing yet.
 */
export function chooseBoundary(path: readonly Message[], keep: number): Boundary | null {
  const live = liveRegion(path)
  const users: number[] = []
  path.forEach((m, i) => i > live.at && m.role === 'user' && users.push(i))
  if (users.length < 2) return null
  const k = Math.min(Math.max(1, keep), users.length - 1)
  const boundary = users[users.length - k] - 1
  if (boundary <= live.at) return null
  return { node: path[boundary], messages: path.slice(live.at + 1, boundary + 1), previous: live.compaction }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${(s.length - n).toLocaleString()} more characters]` : s)

/** Plain-text rendering of messages for the summarizer (no reasoning, no raw blocks). */
export function transcriptFor(messages: readonly Message[], perMessage = 6000): string {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = [...(m.attachments ?? []).map((a) => `[image: ${a.name}]`), m.content].filter(Boolean)
      if (parts.length) out.push(`User: ${clip(parts.join('\n'), perMessage)}`)
    } else if (m.role === 'assistant') {
      const lines: string[] = []
      if (m.content.trim()) lines.push(clip(m.content, perMessage))
      for (const c of m.toolCalls ?? []) lines.push(`[tool ${c.name}${c.summary ? ` — ${clip(c.summary, 200)}` : ''}${c.result ? ` → ${clip(c.result, 500)}` : ''}]`)
      if (m.error && !lines.length) continue
      if (lines.length) out.push(`Assistant: ${lines.join('\n')}`)
    }
  }
  return out.join('\n\n')
}

/** Split into pieces that each fit `maxTokens`, so a huge history is summarized in several passes. */
export function chunkTranscripts(messages: readonly Message[], maxTokens: number): string[] {
  const chunks: string[] = []
  let cur: Message[] = []
  let size = 0
  const flush = () => {
    const t = transcriptFor(cur)
    if (t) chunks.push(t)
    cur = []
    size = 0
  }
  for (const m of messages) {
    const n = Math.min(estimateMessage(m), 2500)
    if (cur.length && size + n > maxTokens) flush()
    cur.push(m)
    size += n
  }
  flush()
  return chunks
}

export const SUMMARY_SYSTEM =
  'You condense conversations so an AI assistant can continue them later with no other memory of what was said. ' +
  'Be faithful: never invent facts, and keep exact names, numbers, file paths, commands, code identifiers, decisions and constraints. ' +
  'Reply with the summary only.'

export function summaryRequest(o: { transcript: string; previous?: string; instructions?: string; words?: number }): string {
  const words = o.words ?? 500
  return [
    o.previous ? `Here is the summary of the conversation before this excerpt:\n<previous_summary>\n${o.previous}\n</previous_summary>\n` : '',
    `Here is the next part of the conversation:\n<transcript>\n${o.transcript}\n</transcript>\n`,
    `Write ${o.previous ? 'an updated summary covering both the earlier summary and this excerpt' : 'a summary of this conversation'}, ` +
      `in at most about ${words} words. Cover: what the user is trying to achieve; key facts, decisions and constraints; ` +
      `work done and its current state (files, commands, results); open questions and what remains to do. ` +
      `Prefer bullet points. Do not address the user and do not add commentary.`,
    o.instructions?.trim() ? `\nExtra focus requested by the user: ${o.instructions.trim().slice(0, 500)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export const MAX_SUMMARY_CHARS = 12_000

/** The system-prompt block that stands in for the summarized messages. */
export function summaryBlock(text: string): string {
  return `## Earlier in this conversation (summarized)\nThe start of this conversation was condensed to save space. Treat this summary as established context:\n\n${text}`
}

// ---------------------------------------------------------------- fitting

const TRIM_KEEP_TURNS = 2
const TRIM_RESULT_CHARS = 1500

/** Index of the start of the `n`-th most recent user turn (0 if there are fewer). */
function recentTurnStart(ms: readonly Message[], n: number): number {
  let seen = 0
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === 'user' && ++seen === n) return i
  }
  return 0
}

/** Shrink what the model rarely needs verbatim from older turns: long tool results and images. (Never mutates.) */
export function trimOldMessages(ms: readonly Message[], keepTurns = TRIM_KEEP_TURNS, maxResult = TRIM_RESULT_CHARS): Message[] {
  const cut = recentTurnStart(ms, keepTurns)
  return ms.map((m, i) => {
    if (i >= cut) return m
    let out = m
    if (m.toolCalls?.some((c) => (c.result?.length ?? 0) > maxResult)) {
      out = {
        ...out,
        toolCalls: m.toolCalls.map((c) =>
          c.result && c.result.length > maxResult
            ? { ...c, result: `${c.result.slice(0, Math.floor(maxResult * 0.5))}\n… [${(c.result.length - Math.floor(maxResult * 0.5)).toLocaleString()} characters omitted to save context]` }
            : c
        )
      }
    }
    if (m.attachments?.length) {
      const notes = m.attachments.map((a) => `[image omitted to save context: ${a.name}]`).join('\n')
      out = { ...out, attachments: undefined, content: [m.content, notes].filter(Boolean).join('\n') }
    }
    return out
  })
}

export interface Fit {
  /** Summary standing in for the compacted prefix, if any. */
  summary?: string
  messages: Message[]
  /** Estimated input tokens of what will be sent (incl. overhead). */
  estimate: number
  trimmed: boolean
  /** Messages dropped entirely (oldest first) because even the trimmed history didn't fit. */
  dropped: number
}

/** Split into turns, each starting at a user message (a leading non-user run stays attached to the first turn). */
function turnsOf(ms: Message[]): Message[][] {
  const turns: Message[][] = []
  for (const m of ms) {
    if (m.role === 'user' || !turns.length) turns.push([m])
    else turns.at(-1)!.push(m)
  }
  return turns
}

/**
 * Build the history to send: start after the latest compaction, and only if that's still over `budget`
 * trim old tool results/images, then drop the oldest whole turns (always keeping the newest).
 */
export function fitToWindow(path: readonly Message[], o: { budget: number; overhead: number }): Fit {
  const live = liveRegion(path)
  const fixed = o.overhead + (live.compaction ? estimateText(live.compaction.text) + 40 : 0)
  let messages = live.messages
  let estimate = fixed + estimateMessages(messages)
  let trimmed = false
  let dropped = 0
  if (estimate > o.budget) {
    messages = trimOldMessages(messages)
    trimmed = true
    estimate = fixed + estimateMessages(messages)
    if (estimate > o.budget) {
      const turns = turnsOf(messages)
      while (estimate > o.budget && turns.length > 1) {
        const gone = turns.shift()!
        dropped += gone.length
        estimate -= estimateMessages(gone)
      }
      messages = turns.flat()
    }
  }
  return { summary: live.compaction?.text, messages, estimate, trimmed, dropped }
}

// ---------------------------------------------------------------- usage meter

export interface ContextUsage {
  /** Tokens the next request will use (best estimate). */
  used: number
  window: number
  windowSource: WindowSource
  /** 'reported' = anchored on the provider's last usage numbers; 'estimated' = counted locally. */
  source: 'reported' | 'estimated'
  parts: { system: number; tools: number; summary: number; messages: number }
  /** Auto-summarize threshold in tokens (0 = auto off). */
  autoAt: number
  compactions: number
  /** Whether "Compact now" would do anything. */
  canCompact: boolean
}

export function contextUsage(
  path: readonly Message[],
  o: { systemTokens: number; toolTokens: number; window: WindowInfo; settings: ContextSettings }
): ContextUsage {
  const live = liveRegion(path)
  const summary = live.compaction ? estimateText(live.compaction.text) + 40 : 0
  const messages = estimateMessages(live.messages)
  let used = o.systemTokens + o.toolTokens + summary + messages
  let source: ContextUsage['source'] = 'estimated'

  // Anchor on the provider's own count from the last answer, then add what came after it.
  for (let i = live.messages.length - 1; i >= 0; i--) {
    const u = live.messages[i].usage
    if (live.messages[i].role === 'assistant' && u?.input) {
      used = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? estimateMessage(live.messages[i])) + estimateMessages(live.messages.slice(i + 1))
      source = 'reported'
      break
    }
  }
  return {
    used,
    window: o.window.tokens,
    windowSource: o.window.source,
    source,
    parts: { system: o.systemTokens, tools: o.toolTokens, summary, messages },
    autoAt: o.settings.auto ? autoCompactAt(o.window.tokens, o.settings) : 0,
    compactions: path.filter((m) => m.compaction).length,
    canCompact: chooseBoundary(path, KEEP_TURNS_MANUAL) !== null
  }
}

/** Convenience for callers holding a whole conversation. */
export const contextUsageFor = (c: Parameters<typeof pathOf>[0], o: Parameters<typeof contextUsage>[1]) => contextUsage(pathOf(c), o)
