import { describe, expect, it } from 'vitest'
import { highlight, MAX_HITS_PER_CHAT, MAX_RESULTS, parseQuery, searchConversations } from '../src/shared/search'
import type { Conversation, Message } from '../src/shared/types'

let t = 1
const m = (id: string, role: Message['role'], parentId: string | null, content: string, over: Partial<Message> = {}): Message => ({ id, role, content, parentId, createdAt: t++, ...over })
const conv = (id: string, title: string, messages: Message[], over: Partial<Conversation> = {}): Conversation => ({ id, title, createdAt: 1, updatedAt: 1, messages, ...over })
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join('')

describe('parseQuery', () => {
  it('lower-cases, dedupes, supports quoted phrases and caps terms', () => {
    expect(parseQuery('  Foo foo "Bar Baz" qux ')).toEqual(['foo', 'bar baz', 'qux'])
    expect(parseQuery('   ')).toEqual([])
    expect(parseQuery('a b c d e f g h i j')).toHaveLength(8)
  })
})

describe('highlight', () => {
  it('marks matches case-insensitively and merges overlapping marks', () => {
    const parts = highlight('The Quick brown quick fox', ['quick', 'quick brown'])
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Quick brown', 'quick'])
    expect(text(parts)).toBe('The Quick brown quick fox')
  })
  it('handles no match and regex characters literally', () => {
    expect(highlight('abc', ['z'])).toEqual([{ text: 'abc', hit: false }])
    expect(highlight('a.b a+b', ['a.b']).filter((p) => p.hit)).toHaveLength(1)
    expect(highlight('', ['a'])).toEqual([])
  })
})

describe('searchConversations', () => {
  const a = conv('a', 'Cooking', [m('u', 'user', null, 'How do I roast a chicken?'), m('r', 'assistant', 'u', 'Preheat the oven and season the chicken well.')], { updatedAt: 10 })
  const b = conv('b', 'Garden', [m('u', 'user', null, 'When to plant tomatoes?'), m('r', 'assistant', 'u', 'After the last frost.')], { updatedAt: 20 })

  it('finds text inside message bodies, not just titles', () => {
    const r = searchConversations([a, b], 'frost')
    expect(r.map((x) => x.conversationId)).toEqual(['b'])
    expect(r[0].hits[0].messageId).toBe('r')
    expect(text(r[0].hits[0].parts)).toContain('last frost')
    expect(r[0].hits[0].parts.some((p) => p.hit && p.text === 'frost')).toBe(true)
  })

  it('ANDs terms across the whole chat, not necessarily in one message', () => {
    expect(searchConversations([a], 'roast oven').map((x) => x.conversationId)).toEqual(['a'])
    expect(searchConversations([a], 'roast tomatoes')).toEqual([])
  })

  it('searches inactive branches and flags them', () => {
    const c = conv('c', 'Branchy', [
      m('u1', 'user', null, 'original question'),
      m('a1', 'assistant', 'u1', 'answer one'),
      m('a2', 'assistant', 'u1', 'secret variant answer')
    ], { leafId: 'a1' })
    const r = searchConversations([c], 'variant')
    expect(r).toHaveLength(1)
    expect(r[0].hits[0]).toMatchObject({ messageId: 'a2', onActivePath: false })
    expect(searchConversations([c], 'answer')[0].hits.some((h) => h.onActivePath)).toBe(true)
  })

  it('matches title, attachment names and tool summaries', () => {
    const c = conv('d', 'Invoice review', [
      m('u', 'user', null, '', { attachments: [{ id: 'x'.repeat(64), name: 'receipt-2024.png', mime: 'image/png', size: 1 }] }),
      m('r', 'assistant', 'u', 'done', { toolCalls: [{ id: 't', name: 'run', arguments: '{}', status: 'done', summary: '$ grep widgets' }] })
    ])
    expect(searchConversations([c], 'invoice')[0].titleParts.some((p) => p.hit)).toBe(true)
    expect(searchConversations([c], 'receipt-2024')[0].hits[0].messageId).toBe('u')
    expect(searchConversations([c], 'widgets')[0].hits[0].messageId).toBe('r')
  })

  it('ranks title matches first, then most recent', () => {
    const old = conv('old', 'Chicken facts', [m('u', 'user', null, 'chicken')], { updatedAt: 1 })
    const r = searchConversations([b, a, old], 'chicken')
    expect(r.map((x) => x.conversationId)).toEqual(['old', 'a'])
    const x = conv('x', 'x', [m('u', 'user', null, 'zebra')], { updatedAt: 5 })
    const y = conv('y', 'y', [m('u', 'user', null, 'zebra')], { updatedAt: 9 })
    expect(searchConversations([x, y], 'zebra').map((r) => r.conversationId)).toEqual(['y', 'x'])
  })

  it('caps hits per chat but reports the total, and caps results', () => {
    const many = conv('m', 'many', Array.from({ length: 10 }, (_, i) => m(`u${i}`, 'user', i ? `u${i - 1}` : null, `needle ${i}`)))
    const r = searchConversations([many], 'needle')[0]
    expect(r.hits).toHaveLength(MAX_HITS_PER_CHAT)
    expect(r.matchCount).toBe(10)
    const lots = Array.from({ length: MAX_RESULTS + 15 }, (_, i) => conv(`c${i}`, 'n', [m('u', 'user', null, 'needle')], { updatedAt: i }))
    expect(searchConversations(lots, 'needle')).toHaveLength(MAX_RESULTS)
  })

  it('builds a bounded snippet around the match with ellipses', () => {
    const long = 'x '.repeat(200) + 'FINDME' + ' y'.repeat(200)
    const hit = searchConversations([conv('l', 'l', [m('u', 'user', null, long)])], 'findme')[0].hits[0]
    const s = text(hit.parts)
    expect(s.length).toBeLessThan(200)
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
    expect(s).toContain('FINDME')
  })

  it('returns nothing for empty queries and skips empty chats', () => {
    expect(searchConversations([a], '  ')).toEqual([])
    expect(searchConversations([conv('e', 'needle', [])], 'needle')).toEqual([])
  })
})
