import { randomUUID } from 'node:crypto'
import { childrenOf, lastUserOnPath, pathOf, setLeaf } from '../shared/tree'
import type { Attachment, Conversation, Message } from '../shared/types'

/** Pure edits to a conversation tree (no I/O), so the branching rules are unit-testable. */

export class OpError extends Error {}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || 'New chat'
}

interface UserInput {
  content: string
  attachments?: Attachment[]
  skill?: Message['skill']
}

/** Append a user message to the visible branch and make it the leaf. */
export function addUserMessage(conv: Conversation, input: UserInput): Message {
  const leaf = pathOf(conv).at(-1)
  const node: Message = { id: randomUUID(), role: 'user', content: input.content, createdAt: Date.now(), parentId: leaf?.id ?? null }
  if (input.attachments?.length) node.attachments = input.attachments
  if (input.skill) node.skill = input.skill
  if (conv.messages.length === 0) {
    conv.title = titleFrom(input.content || input.attachments?.[0]?.name || 'Image')
    conv.titleSource = 'auto'
  }
  conv.messages.push(node)
  setLeaf(conv, node.id)
  return node
}

/** Edit = a new sibling of the original user message (the original and everything after it is kept as another branch). */
export function editUserMessage(conv: Conversation, messageId: string, input: UserInput): Message {
  const orig = conv.messages.find((m) => m.id === messageId)
  if (!orig) throw new OpError('Message not found')
  if (orig.role !== 'user') throw new OpError('Only your own messages can be edited')
  const node: Message = { id: randomUUID(), role: 'user', content: input.content, createdAt: Date.now(), parentId: orig.parentId ?? null }
  const attachments = input.attachments ?? orig.attachments
  if (attachments?.length) node.attachments = attachments
  if (input.skill) node.skill = input.skill
  conv.messages.push(node)
  setLeaf(conv, node.id)
  // Rewriting the opening message re-derives the title (a generated one no longer fits) — but never over one the user typed.
  if (!orig.parentId && conv.titleSource !== 'manual') {
    conv.title = titleFrom(input.content || attachments?.[0]?.name || 'Image')
    conv.titleSource = 'auto'
  }
  return node
}

/**
 * Regenerate = another answer to the last user message; the previous answer stays as an earlier variant.
 * A failed answer with nothing worth keeping is replaced instead of piling up as variants.
 * Returns the user message the new answer should hang under.
 */
export function prepareRegenerate(conv: Conversation): Message {
  const user = lastUserOnPath(conv)
  if (!user) throw new OpError('Nothing to regenerate')
  const failed = childrenOf(conv, user.id).filter((m) => m.role === 'assistant' && m.error && !m.content.trim() && !m.toolCalls?.length && !childrenOf(conv, m.id).length)
  if (failed.length) conv.messages = conv.messages.filter((m) => !failed.includes(m))
  setLeaf(conv, user.id)
  return user
}
