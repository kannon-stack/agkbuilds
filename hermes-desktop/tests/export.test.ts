import { describe, expect, it } from 'vitest'
import { exportFileName, toJson, toMarkdown } from '../src/shared/export'
import type { Conversation, Message } from '../src/shared/types'

let t = 1_700_000_000_000
const m = (id: string, role: Message['role'], parentId: string | null, over: Partial<Message> = {}): Message => ({ id, role, content: id, createdAt: t++, parentId, ...over })
const conv = (messages: Message[], over: Partial<Conversation> = {}): Conversation => ({ id: 'c', title: 'My chat', createdAt: 1_700_000_000_000, updatedAt: 1, messages, ...over })

describe('toMarkdown', () => {
  it('exports only the visible branch, in order', () => {
    const c = conv([m('u1', 'user', null), m('a1', 'assistant', 'u1', { model: 'gpt' }), m('a1b', 'assistant', 'u1', { content: 'other branch' })], { leafId: 'a1' })
    const md = toMarkdown(c)
    expect(md).toMatch(/^# My chat\n/)
    expect(md).toContain('## You\n\nu1')
    expect(md).toContain('## gpt\n\na1')
    expect(md).not.toContain('other branch')
  })

  it('summarizes tool calls and truncates long results', () => {
    const c = conv([m('u1', 'user', null), m('a1', 'assistant', 'u1', { content: '', toolCalls: [{ id: 't', name: 'read_file', arguments: '{}', status: 'done', summary: 'read a.txt', label: 'Read files', result: 'x'.repeat(5000) }] })], { leafId: 'a1' })
    const md = toMarkdown(c)
    expect(md).toContain('**Tool:** Read files — `read a.txt`')
    expect(md).toContain('more characters')
    expect(md.length).toBeLessThan(3000)
  })

  it('fences cannot be broken out of by backticks in results', () => {
    const c = conv([m('a1', 'assistant', null, { content: '', toolCalls: [{ id: 't', name: 'x', arguments: '{}', status: 'done', result: 'before\n```\nafter' }] })])
    expect(toMarkdown(c)).toContain('````\nbefore\n```\nafter\n````')
  })

  it('hides reasoning unless asked, and marks errors and images', () => {
    const c = conv([
      m('u1', 'user', null, { attachments: [{ id: 'a'.repeat(64), name: 'cat.png', mime: 'image/png', size: 1 }], skill: { name: 'review', text: '..' } }),
      m('a1', 'assistant', 'u1', { content: 'partial', thinking: 'secret thoughts', error: 'boom\nline2' })
    ], { leafId: 'a1' })
    const off = toMarkdown(c)
    expect(off).not.toContain('secret thoughts')
    expect(off).toContain('_[image: cat.png]_')
    expect(off).toContain('_Skill: review_')
    expect(off).toContain('> **Error:** boom line2')
    expect(toMarkdown(c, { reasoning: true })).toContain('secret thoughts')
  })

  it('handles an empty conversation', () => {
    expect(toMarkdown(conv([]))).toMatch(/^# My chat/)
  })
})

describe('toJson', () => {
  it('keeps every branch but drops provider replay blocks', () => {
    const c = conv([m('u1', 'user', null), m('a1', 'assistant', 'u1', { raw: [{ type: 'thinking', signature: 'x' }] }), m('a1b', 'assistant', 'u1')])
    const parsed = JSON.parse(toJson(c))
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[1].raw).toBeUndefined()
    expect(c.messages[1].raw).toBeDefined() // original untouched
  })
})

describe('exportFileName', () => {
  it('makes safe slugs', () => {
    expect(exportFileName(conv([], { title: 'Hello, World! / ../etc' }), 'markdown')).toBe('hello-world-etc.md')
    expect(exportFileName(conv([], { title: '✨✨' }), 'json')).toBe('chat.json')
    expect(exportFileName(conv([], { title: 'x'.repeat(200) }), 'json').length).toBeLessThanOrEqual(53)
  })
})
