// Conversation titles: settings, prompt, and cleaning up what a model returns. Pure.
import { pathOf } from './tree'
import type { Conversation, Message } from './types'

export interface TitleSettings {
  /** Let the model write a short title after the first exchange. */
  enabled: boolean
  /** Model to use (on the chat's provider); empty = the chat's own model. A small/cheap one is plenty. */
  model: string
}

export const DEFAULT_TITLES: TitleSettings = { enabled: true, model: '' }

export function cleanTitleSettings(raw: unknown, base: TitleSettings = DEFAULT_TITLES): TitleSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<TitleSettings>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    model: typeof r.model === 'string' ? r.model.trim().slice(0, 200) : base.model
  }
}

/** Where the current title came from; manual titles are never overwritten automatically. */
export type TitleSource = 'auto' | 'generated' | 'manual'
export const MAX_TITLE_CHARS = 60

export const TITLE_SYSTEM =
  'You write short titles for chat conversations. Reply with the title only: 2 to 6 words, in the same language as the user, ' +
  'no quotes, no markdown, no trailing punctuation, no emoji.'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function titleRequest(user: string, assistant: string): string {
  return `Conversation start:\n\nUser: ${clip(user.trim(), 700)}\n\nAssistant: ${clip(assistant.trim(), 500)}\n\nWrite the title.`
}

/** Turn a model's reply into a usable title, or null if it isn't one. */
export function sanitizeTitle(raw: string): string | null {
  let t = raw
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!t) return null
  t = t
    .replace(/^(?:#+\s*|[-*•]\s+)/, '') // heading / bullet markers
    .replace(/^(?:title|chat title|conversation title)\s*[:：-]\s*/i, '')
    .replace(/[`*]/g, '') // inline code / emphasis markers
    .replace(/^["'“”‘’_]+|["'“”‘’_]+$/g, '') // wrapping quotes
    .replace(/\s+/g, ' ')
    .replace(/[.!?:;,、。！？]+$/, '')
    .trim()
  if (t.length < 2 || t.length > 90) return null // empty, or the model rambled instead of titling
  if (t.length > MAX_TITLE_CHARS) {
    const cut = t.slice(0, MAX_TITLE_CHARS)
    t = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 30))}…`
  }
  return t
}

/** The first user message and the first non-empty answer on the visible branch (the basis for a title). */
export function titleBasis(conv: Pick<Conversation, 'messages' | 'leafId' | 'rootChild'>): { user: string; assistant: string } | null {
  const path = pathOf(conv)
  const user: Message | undefined = path.find((m) => m.role === 'user' && (m.content.trim() || m.attachments?.length))
  if (!user) return null
  const answer = path.find((m) => m.role === 'assistant' && !m.error && m.content.trim())
  if (!answer) return null
  return { user: user.content.trim() || `[image: ${user.attachments?.[0]?.name ?? 'image'}]`, assistant: answer.content }
}

/** Retry automatically only in the first few turns, and never over a title the user (or the model) already settled. */
export function wantsAutoTitle(conv: Pick<Conversation, 'titleSource' | 'messages' | 'leafId' | 'rootChild'>): boolean {
  if (conv.titleSource === 'manual' || conv.titleSource === 'generated') return false
  return pathOf(conv).filter((m) => m.role === 'user').length <= 3
}
