// Full-text search over conversations (every message of every branch). Pure, so it's testable and cheap to reason about.
import { pathOf } from './tree'
import type { Conversation, Message } from './types'

export interface SnippetPart {
  text: string
  hit: boolean
}

export interface SearchHit {
  messageId: string
  role: Message['role']
  parts: SnippetPart[]
  /** False when the message lives on a branch that isn't currently shown (opening it switches branches). */
  onActivePath: boolean
}

export interface SearchResult {
  conversationId: string
  title: string
  titleParts: SnippetPart[]
  updatedAt: number
  /** Up to MAX_HITS_PER_CHAT best messages. */
  hits: SearchHit[]
  /** How many messages matched in total. */
  matchCount: number
}

export const MAX_RESULTS = 30
export const MAX_HITS_PER_CHAT = 3
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 90

/** Lower-cased unique terms; quotes group a phrase. */
export function parseQuery(q: string): string[] {
  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  for (let m = re.exec(q); m; m = re.exec(q)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase()
    if (t && !terms.includes(t)) terms.push(t)
  }
  return terms.slice(0, 8)
}

/** Split text into parts, flagging the pieces that match any term. */
export function highlight(text: string, terms: string[]): SnippetPart[] {
  const lower = text.toLowerCase()
  const marks: [number, number][] = []
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length])
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const r of marks) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const parts: SnippetPart[] = []
  let at = 0
  for (const [s, e] of merged) {
    if (s > at) parts.push({ text: text.slice(at, s), hit: false })
    parts.push({ text: text.slice(s, e), hit: true })
    at = e
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}

/** A window of `text` around the first term occurrence, whitespace collapsed. */
function snippet(text: string, terms: string[]): SnippetPart[] {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length)
  const start = Math.max(0, first - SNIPPET_BEFORE)
  const end = Math.min(flat.length, first + SNIPPET_AFTER)
  const cut = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
  return highlight(cut, terms)
}

/** Everything searchable about one message. */
function searchable(m: Message): string {
  return [m.content, ...(m.attachments ?? []).map((a) => a.name), ...(m.toolCalls ?? []).map((c) => c.summary ?? '')].filter(Boolean).join('\n')
}

export function searchConversations(convs: Conversation[], query: string): SearchResult[] {
  const terms = parseQuery(query)
  if (!terms.length) return []
  const out: (SearchResult & { titleMatch: boolean })[] = []

  for (const c of convs) {
    if (!c.messages.length) continue
    const title = c.title.toLowerCase()
    const texts = c.messages.map((m) => ({ m, lower: searchable(m).toLowerCase() }))
    // Every term must appear somewhere in the chat (title or any message), not necessarily in the same message.
    if (!terms.every((t) => title.includes(t) || texts.some((x) => x.lower.includes(t)))) continue

    const onPath = new Set(pathOf(c).map((m) => m.id))
    const matched = texts
      .map((x) => ({ ...x, score: terms.filter((t) => x.lower.includes(t)).length }))
      .filter((x) => x.score > 0)
      // Messages with more of the terms first; then the visible branch; then newest.
      .sort((a, b) => b.score - a.score || Number(onPath.has(b.m.id)) - Number(onPath.has(a.m.id)) || b.m.createdAt - a.m.createdAt)

    out.push({
      conversationId: c.id,
      title: c.title,
      titleParts: highlight(c.title, terms),
      titleMatch: terms.some((t) => title.includes(t)),
      updatedAt: c.updatedAt,
      matchCount: matched.length,
      hits: matched.slice(0, MAX_HITS_PER_CHAT).map(({ m }) => ({
        messageId: m.id,
        role: m.role,
        parts: snippet(searchable(m), terms),
        onActivePath: onPath.has(m.id)
      }))
    })
  }

  return out
    .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_RESULTS)
    .map(({ titleMatch: _t, ...r }) => r)
}
