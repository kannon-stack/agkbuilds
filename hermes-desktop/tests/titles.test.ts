import { describe, expect, it } from 'vitest'
import { cleanTitleSettings, DEFAULT_TITLES, MAX_TITLE_CHARS, sanitizeTitle, titleBasis, titleRequest, wantsAutoTitle } from '../src/shared/titles'
import { addUserMessage, editUserMessage } from '../src/main/conversationOps'
import { setLeaf } from '../src/shared/tree'
import type { Conversation, Message } from '../src/shared/types'

let t = 1
const m = (id: string, role: Message['role'], parentId: string | null, content: string, over: Partial<Message> = {}): Message => ({ id, role, content, parentId, createdAt: t++, ...over })
const conv = (messages: Message[], over: Partial<Conversation> = {}): Conversation => ({ id: 'c', title: 'T', createdAt: 1, updatedAt: 1, messages, ...over })

describe('sanitizeTitle', () => {
  it.each([
    ['Fixing a Python Import Error', 'Fixing a Python Import Error'],
    ['"Fixing a Python Import Error"', 'Fixing a Python Import Error'],
    ['“Trip Planning for Lisbon.”', 'Trip Planning for Lisbon'],
    ['Title: Weekly Meal Prep Ideas', 'Weekly Meal Prep Ideas'],
    ['**Budget Spreadsheet Help**', 'Budget Spreadsheet Help'],
    ['# Regex for Emails', 'Regex for Emails'],
    ['- Kubernetes Basics', 'Kubernetes Basics'],
    ['`git rebase` Tips!', 'git rebase Tips'],
    ['Plan a trip\n\nHere is why I chose it…', 'Plan a trip'],
    ['\n\n  Spaced   out   title  \n', 'Spaced out title'],
    ['日本語のタイトル。', '日本語のタイトル']
  ])('cleans %j', (raw, want) => expect(sanitizeTitle(raw)).toBe(want))

  it('rejects empty, one-character, and rambling replies', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   \n ')).toBeNull()
    expect(sanitizeTitle('"."')).toBeNull()
    expect(sanitizeTitle('I think a good title for this conversation would probably be something about databases and indexing strategies')).toBeNull()
  })

  it('shortens long-but-plausible titles on a word boundary', () => {
    const out = sanitizeTitle('A rather long descriptive title about migrating our billing database to Postgres')!
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s…$/)
  })
})

describe('settings', () => {
  it('validates and defaults', () => {
    expect(cleanTitleSettings(undefined)).toEqual(DEFAULT_TITLES)
    expect(cleanTitleSettings({ enabled: false, model: '  haiku  ' })).toEqual({ enabled: false, model: 'haiku' })
    expect(cleanTitleSettings({ enabled: 'no', model: 5 })).toEqual(DEFAULT_TITLES)
    expect(cleanTitleSettings({ model: 'x'.repeat(500) }).model).toHaveLength(200)
    expect(cleanTitleSettings({ enabled: false }, { enabled: true, model: 'keep' })).toEqual({ enabled: false, model: 'keep' })
  })
})

describe('titleBasis / titleRequest', () => {
  it('uses the first user message and the first real answer on the visible branch', () => {
    const c = conv([m('u1', 'user', null, 'How do I X?'), m('a0', 'assistant', 'u1', '', { error: 'boom' }), m('a1', 'assistant', 'u1', 'Do Y.'), m('a1b', 'assistant', 'u1', 'Other branch')], { leafId: 'a1' })
    setLeaf(c, 'a1')
    expect(titleBasis(c)).toEqual({ user: 'How do I X?', assistant: 'Do Y.' })
  })
  it('needs both a user message and an answer; describes image-only messages', () => {
    expect(titleBasis(conv([]))).toBeNull()
    expect(titleBasis(conv([m('u1', 'user', null, 'hi')]))).toBeNull()
    const img = { id: 'a'.repeat(64), name: 'cat.png', mime: 'image/png' as const, size: 1 }
    expect(titleBasis(conv([m('u1', 'user', null, '', { attachments: [img] }), m('a1', 'assistant', 'u1', 'A cat.')]))?.user).toBe('[image: cat.png]')
  })
  it('clips long inputs', () => {
    expect(titleRequest('u'.repeat(5000), 'a'.repeat(5000)).length).toBeLessThan(1400)
  })
})

describe('wantsAutoTitle', () => {
  const chat = (turns: number, over: Partial<Conversation> = {}) => {
    const ms: Message[] = []
    for (let i = 0; i < turns; i++) {
      ms.push(m(`u${i}`, 'user', i ? `a${i - 1}` : null, `q${i}`), m(`a${i}`, 'assistant', `u${i}`, `r${i}`))
    }
    return conv(ms, over)
  }
  it('retries only for placeholder titles in the first few turns', () => {
    expect(wantsAutoTitle(chat(1))).toBe(true)
    expect(wantsAutoTitle(chat(3, { titleSource: 'auto' }))).toBe(true)
    expect(wantsAutoTitle(chat(4))).toBe(false)
    expect(wantsAutoTitle(chat(1, { titleSource: 'generated' }))).toBe(false)
    expect(wantsAutoTitle(chat(1, { titleSource: 'manual' }))).toBe(false)
  })
})

describe('title source in conversation ops', () => {
  it('a new chat starts with an auto placeholder title', () => {
    const c = conv([], { title: 'New chat' })
    addUserMessage(c, { content: 'Hello there' })
    expect(c).toMatchObject({ title: 'Hello there', titleSource: 'auto' })
  })
  it('editing the opening message re-derives auto and generated titles', () => {
    const c = conv([m('u1', 'user', null, 'old')], { title: 'Generated Title', titleSource: 'generated' })
    editUserMessage(c, 'u1', { content: 'a different topic' })
    expect(c).toMatchObject({ title: 'a different topic', titleSource: 'auto' })
  })
  it('editing never overwrites a title the user typed', () => {
    const c = conv([m('u1', 'user', null, 'old')], { title: 'My name', titleSource: 'manual' })
    editUserMessage(c, 'u1', { content: 'new text' })
    expect(c).toMatchObject({ title: 'My name', titleSource: 'manual' })
  })
  it('editing later messages leaves the title alone', () => {
    const c = conv([m('u1', 'user', null, 'q'), m('a1', 'assistant', 'u1', 'r'), m('u2', 'user', 'a1', 'follow up')], { title: 'Generated Title', titleSource: 'generated' })
    editUserMessage(c, 'u2', { content: 'follow up 2' })
    expect(c.title).toBe('Generated Title')
  })
})
