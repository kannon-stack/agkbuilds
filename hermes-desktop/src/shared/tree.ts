// The conversation is a tree of messages; the chat you see is one root→leaf path. Pure helpers, shared by main, renderer and tests.
import type { Conversation, Message } from './types'

type Tree = Pick<Conversation, 'messages' | 'leafId' | 'rootChild'>

const byId = (c: Tree) => new Map(c.messages.map((m) => [m.id, m]))

/**
 * Old conversations are plain lists: link each message to the one before it, and show the last one.
 * Also repairs hand-edited/corrupt data (dangling parents become roots; a bad leaf falls back to the last node).
 */
export function normalizeTree<T extends Tree>(c: T): T {
  const legacy = c.messages.length > 0 && c.messages.every((m) => m.parentId === undefined)
  if (legacy) c.messages.forEach((m, i) => (m.parentId = i === 0 ? null : c.messages[i - 1].id))
  const ids = new Set(c.messages.map((m) => m.id))
  for (const m of c.messages) {
    if (m.parentId === undefined || (m.parentId !== null && !ids.has(m.parentId))) m.parentId = null
    if (m.activeChild && !ids.has(m.activeChild)) delete m.activeChild
  }
  if (!c.leafId || !ids.has(c.leafId)) c.leafId = c.messages.at(-1)?.id
  if (c.rootChild && !ids.has(c.rootChild)) delete c.rootChild
  return c
}

/** root → `id` (inclusive). Cycle-safe: a malformed parent loop just ends the walk. */
export function pathTo(c: Tree, id: string | null | undefined): Message[] {
  if (!id) return []
  const map = byId(c)
  const out: Message[] = []
  const seen = new Set<string>()
  for (let cur = map.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? map.get(cur.parentId) : undefined) {
    seen.add(cur.id)
    out.push(cur)
  }
  return out.reverse()
}

/** The messages currently on screen. */
export const pathOf = (c: Tree): Message[] => pathTo(c, c.leafId ?? c.messages.at(-1)?.id)

/** Children of `parentId` (null = roots), oldest first. */
export function childrenOf(c: Tree, parentId: string | null): Message[] {
  return c.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (m.parentId ?? null) === parentId)
    .sort((a, b) => a.m.createdAt - b.m.createdAt || a.i - b.i)
    .map(({ m }) => m)
}

export interface SiblingInfo {
  /** 1-based position among the alternatives. */
  index: number
  count: number
  ids: string[]
}

export function siblingInfo(c: Tree, m: Message): SiblingInfo {
  const ids = childrenOf(c, m.parentId ?? null).map((x) => x.id)
  return { index: Math.max(1, ids.indexOf(m.id) + 1), count: ids.length, ids }
}

const activeChildId = (c: Tree, parentId: string | null, kids: Message[]): Message | undefined => {
  const pref = parentId ? c.messages.find((m) => m.id === parentId)?.activeChild : c.rootChild
  return kids.find((k) => k.id === pref) ?? kids.at(-1)
}

/** Follow each node's remembered (else newest) child down to a leaf. */
export function descend(c: Tree, id: string): string {
  let cur = id
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(cur)) return cur
    seen.add(cur)
    const kids = childrenOf(c, cur)
    const next = activeChildId(c, cur, kids)
    if (!next) return cur
    cur = next.id
  }
}

/** Make `leafId` the visible branch and remember the choice at every fork on the way. */
export function setLeaf<T extends Tree>(c: T, leafId: string): T {
  const path = pathTo(c, leafId)
  path.forEach((m, i) => {
    if (i === 0) c.rootChild = m.id
    else path[i - 1].activeChild = m.id
  })
  c.leafId = leafId
  return c
}

/** Show the branch through `messageId` (landing on that branch's remembered/newest end). */
export const switchTo = <T extends Tree>(c: T, messageId: string): T => setLeaf(c, descend(c, messageId))

/** Last user message on the visible path (what Regenerate re-answers). */
export const lastUserOnPath = (c: Tree): Message | undefined => [...pathOf(c)].reverse().find((m) => m.role === 'user')
