import { describe, expect, it } from 'vitest'
import { childrenOf, descend, lastUserOnPath, normalizeTree, pathOf, pathTo, setLeaf, siblingInfo, switchTo } from '../src/shared/tree'
import { addUserMessage, editUserMessage, OpError, prepareRegenerate, titleFrom } from '../src/main/conversationOps'
import type { Conversation, Message } from '../src/shared/types'

let t = 1000
const msg = (id: string, role: Message['role'], parentId: string | null | undefined, over: Partial<Message> = {}): Message => ({
  id, role, content: id, createdAt: t++, ...(parentId === undefined ? {} : { parentId }), ...over
})
const conv = (messages: Message[], over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', title: 'T', createdAt: 1, updatedAt: 1, messages, ...over
})
const ids = (ms: Message[]) => ms.map((m) => m.id)

describe('normalizeTree', () => {
  it('links a legacy linear conversation and shows the last message', () => {
    const c = normalizeTree(conv([msg('u1', 'user', undefined), msg('a1', 'assistant', undefined), msg('u2', 'user', undefined)]))
    expect(c.messages.map((m) => m.parentId)).toEqual([null, 'u1', 'a1'])
    expect(c.leafId).toBe('u2')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1', 'u2'])
  })

  it('leaves tree data alone and is idempotent', () => {
    const c = normalizeTree(conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1')], { leafId: 'a1' }))
    const before = JSON.stringify(c)
    expect(JSON.stringify(normalizeTree(c))).toBe(before)
  })

  it('repairs dangling parents, bad leaf and bad pointers', () => {
    const c = normalizeTree(conv([msg('u1', 'user', null, { activeChild: 'ghost' }), msg('a1', 'assistant', 'nope')], { leafId: 'missing', rootChild: 'ghost' }))
    expect(c.messages[1].parentId).toBeNull()
    expect(c.messages[0].activeChild).toBeUndefined()
    expect(c.rootChild).toBeUndefined()
    expect(c.leafId).toBe('a1')
  })

  it('handles an empty conversation', () => {
    const c = normalizeTree(conv([]))
    expect(c.leafId).toBeUndefined()
    expect(pathOf(c)).toEqual([])
  })
})

describe('paths', () => {
  const tree = () =>
    conv([
      msg('u1', 'user', null),
      msg('a1', 'assistant', 'u1'),
      msg('a1b', 'assistant', 'u1'), // regenerated variant
      msg('u2', 'user', 'a1'),
      msg('a2', 'assistant', 'u2')
    ], { leafId: 'a2' })

  it('pathTo walks root → id', () => {
    expect(ids(pathTo(tree(), 'a2'))).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(pathTo(tree(), 'zzz')).toEqual([])
    expect(pathTo(tree(), null)).toEqual([])
  })

  it('survives a parent cycle in corrupt data', () => {
    const c = conv([msg('x', 'user', 'y'), msg('y', 'assistant', 'x')])
    expect(pathTo(c, 'x').length).toBeLessThanOrEqual(2)
    expect(descend(c, 'x')).toBeTruthy()
  })

  it('childrenOf is oldest first, siblingInfo is 1-based', () => {
    const c = tree()
    expect(ids(childrenOf(c, 'u1'))).toEqual(['a1', 'a1b'])
    expect(ids(childrenOf(c, null))).toEqual(['u1'])
    expect(siblingInfo(c, c.messages[2])).toEqual({ index: 2, count: 2, ids: ['a1', 'a1b'] })
    expect(siblingInfo(c, c.messages[0]).count).toBe(1)
  })

  it('setLeaf remembers the choice at each fork and switchTo returns to it', () => {
    const c = tree()
    switchTo(c, 'a1b') // other answer: no children yet
    expect(c.leafId).toBe('a1b')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1b'])
    switchTo(c, 'a1') // back: follows the remembered continuation down to a2
    expect(c.leafId).toBe('a2')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('setLeaf on a root sets rootChild', () => {
    const c = conv([msg('u1', 'user', null), msg('u1b', 'user', null)])
    setLeaf(c, 'u1b')
    expect(c.rootChild).toBe('u1b')
    expect(descend(c, 'u1b')).toBe('u1b')
  })

  it('lastUserOnPath picks the last user turn on the visible branch', () => {
    expect(lastUserOnPath(tree())?.id).toBe('u2')
    expect(lastUserOnPath(conv([]))).toBeUndefined()
  })
})

describe('addUserMessage', () => {
  it('starts a conversation and titles it', () => {
    const c = conv([], { title: 'New chat' })
    const m = addUserMessage(c, { content: 'Hello   there' })
    expect(m.parentId).toBeNull()
    expect(c.title).toBe('Hello there')
    expect(c.leafId).toBe(m.id)
  })

  it('appends under the visible leaf, not the newest node overall', () => {
    const c = conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1'), msg('a1b', 'assistant', 'u1')], { leafId: 'a1' })
    setLeaf(c, 'a1')
    const m = addUserMessage(c, { content: 'follow up' })
    expect(m.parentId).toBe('a1')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1', m.id])
  })

  it('keeps an attached skill and attachments', () => {
    const c = conv([])
    const att = { id: 'a'.repeat(64), name: 'x.png', mime: 'image/png' as const, size: 3 }
    const m = addUserMessage(c, { content: '', attachments: [att], skill: { name: 's', text: 't' } })
    expect(m.attachments).toEqual([att])
    expect(m.skill?.name).toBe('s')
    expect(c.title).toBe('x.png')
  })
})

describe('editUserMessage', () => {
  const base = () => {
    const c = conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1'), msg('u2', 'user', 'a1'), msg('a2', 'assistant', 'u2')], { leafId: 'a2' })
    setLeaf(c, 'a2')
    return c
  }

  it('creates a sibling and shows the new branch; the old branch is intact', () => {
    const c = base()
    const e = editUserMessage(c, 'u2', { content: 'rewritten' })
    expect(e.parentId).toBe('a1')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1', e.id])
    expect(siblingInfo(c, e)).toMatchObject({ index: 2, count: 2 })
    switchTo(c, 'u2')
    expect(ids(pathOf(c))).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('editing the first message retitles the chat', () => {
    const c = base()
    editUserMessage(c, 'u1', { content: 'brand new topic' })
    expect(c.title).toBe('brand new topic')
    editUserMessage(c, 'u2', { content: 'later edit' })
    expect(c.title).toBe('brand new topic')
  })

  it('inherits attachments unless replaced', () => {
    const att = { id: 'b'.repeat(64), name: 'p.png', mime: 'image/png' as const, size: 1 }
    const c = conv([msg('u1', 'user', null, { attachments: [att] })], { leafId: 'u1' })
    expect(editUserMessage(c, 'u1', { content: 'again' }).attachments).toEqual([att])
    expect(editUserMessage(c, 'u1', { content: 'none', attachments: [] }).attachments).toBeUndefined()
  })

  it('rejects unknown ids and assistant messages', () => {
    const c = base()
    expect(() => editUserMessage(c, 'nope', { content: 'x' })).toThrow(OpError)
    expect(() => editUserMessage(c, 'a1', { content: 'x' })).toThrow(/own messages/)
  })
})

describe('prepareRegenerate', () => {
  it('keeps the old answer as a variant and points at the user message', () => {
    const c = conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1')], { leafId: 'a1' })
    const u = prepareRegenerate(c)
    expect(u.id).toBe('u1')
    expect(c.messages.map((m) => m.id)).toContain('a1')
    expect(c.leafId).toBe('u1')
  })

  it('regenerates the answer after a tool round as a sibling of the first assistant step', () => {
    const c = conv([
      msg('u1', 'user', null),
      msg('a1', 'assistant', 'u1', { toolCalls: [{ id: 't', name: 'x', arguments: '{}', status: 'done', result: 'r' }] }),
      msg('a2', 'assistant', 'a1')
    ], { leafId: 'a2' })
    expect(prepareRegenerate(c).id).toBe('u1')
    expect(c.messages).toHaveLength(3)
  })

  it('replaces a failed empty answer instead of stacking variants', () => {
    const c = conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1', { content: '', error: 'boom' })], { leafId: 'a1' })
    prepareRegenerate(c)
    expect(ids(c.messages)).toEqual(['u1'])
  })

  it('keeps a failed answer that has partial text', () => {
    const c = conv([msg('u1', 'user', null), msg('a1', 'assistant', 'u1', { content: 'partial', error: 'cut off' })], { leafId: 'a1' })
    prepareRegenerate(c)
    expect(ids(c.messages)).toEqual(['u1', 'a1'])
  })

  it('throws with nothing to answer', () => {
    expect(() => prepareRegenerate(conv([]))).toThrow(OpError)
  })
})

describe('titleFrom', () => {
  it('collapses whitespace and truncates', () => {
    expect(titleFrom('  a\n\n b  ')).toBe('a b')
    expect(titleFrom('x'.repeat(100))).toHaveLength(48)
    expect(titleFrom('   ')).toBe('New chat')
  })
})
