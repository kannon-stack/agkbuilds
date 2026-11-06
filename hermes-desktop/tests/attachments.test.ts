import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AttachmentError, AttachmentStore } from '../src/main/attachments'
import { cleanName, MAX_ATTACHMENT_BYTES, sniffImage } from '../src/shared/attachments'
import { toAnthropicMessages } from '../src/main/anthropic'
import { toWire } from '../src/main/chat'
import type { Attachment, Message } from '../src/shared/types'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPG = Buffer.from('ffd8ffe000104a464946', 'hex')
const GIF = Buffer.from('474946383961010001', 'hex')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

let dir = ''
let store: AttachmentStore
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'att-'))
  store = new AttachmentStore(path.join(dir, 'attachments'))
})

describe('sniffImage', () => {
  it('identifies formats by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPG)).toBe('image/jpeg')
    expect(sniffImage(GIF)).toBe('image/gif')
    expect(sniffImage(WEBP)).toBe('image/webp')
  })
  it('rejects everything else, including truncated and disguised files', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffImage(Buffer.from('%PDF-1.4'))).toBeNull()
    expect(sniffImage(Buffer.from('MZ\x90\x00'))).toBeNull()
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull()
  })
})

describe('cleanName', () => {
  it('strips paths and control characters, bounds length, and falls back', () => {
    expect(cleanName('../../etc/passwd.png', 'image/png')).toBe('passwd.png')
    expect(cleanName('C:\\Users\\me\\cat.jpg', 'image/jpeg')).toBe('cat.jpg')
    expect(cleanName('a\u0000b\nc.png', 'image/png')).toBe('abc.png')
    expect(cleanName('x'.repeat(300), 'image/png')).toHaveLength(80)
    expect(cleanName('', 'image/webp')).toBe('image.webp')
    expect(cleanName('dir/', 'image/gif')).toBe('image.gif')
  })
})

describe('AttachmentStore', () => {
  it('saves content-addressed and dedupes identical bytes', async () => {
    const a = await store.save(PNG, 'one.png')
    const b = await store.save(PNG, 'two.png')
    expect(a.id).toBe(b.id)
    expect(a).toMatchObject({ mime: 'image/png', size: PNG.length, name: 'one.png' })
    expect(readdirSync(store.dir)).toEqual([`${a.id}.png`])
  })

  it('validates by content, size, and emptiness', async () => {
    await expect(store.save(Buffer.from('not an image'), 'x.png')).rejects.toThrow(AttachmentError)
    await expect(store.save(Buffer.alloc(0), 'x.png')).rejects.toThrow(/empty/)
    await expect(store.save(Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]), 'big.png')).rejects.toThrow(/under 5 MB/)
    expect(existsSync(store.dir) ? readdirSync(store.dir) : []).toEqual([])
  })

  it('reads back as a data URL and tolerates missing files', async () => {
    const a = await store.save(JPG, 'a.jpg')
    expect(await store.dataUrl(a)).toBe(`data:image/jpeg;base64,${JPG.toString('base64')}`)
    expect(await store.dataUrl({ ...a, id: 'f'.repeat(64) })).toBeNull()
  })

  it('refuses ids that could escape the folder', async () => {
    const bad: Attachment = { id: '../../etc/passwd', name: 'x', mime: 'image/png', size: 1 }
    expect(await store.read(bad)).toBeNull()
    expect(await store.verify(bad)).toBeNull()
    expect(await store.verify({ id: 'a'.repeat(64), name: 'x', mime: 'text/html' as never, size: 1 })).toBeNull()
  })

  it('verify trusts the file, not the descriptor', async () => {
    const a = await store.save(PNG, 'a.png')
    const v = await store.verify({ ...a, size: 999999, name: '../../evil.png' })
    expect(v).toEqual({ ...a, name: 'evil.png' })
    expect(await store.verify({ ...a, mime: 'image/jpeg' })).toBeNull()
    // file swapped for non-image contents after saving
    writeFileSync(path.join(store.dir, `${a.id}.png`), 'oops')
    expect(await store.verify(a)).toBeNull()
  })

  it('verifyAll enforces count, dedupes, and rejects unknown files', async () => {
    const a = await store.save(PNG, 'a.png')
    const b = await store.save(JPG, 'b.jpg')
    expect(await store.verifyAll([a, a, b])).toHaveLength(2)
    expect(await store.verifyAll(undefined)).toEqual([])
    await expect(store.verifyAll(Array.from({ length: 7 }, () => a))).rejects.toThrow(/up to 6/)
    await expect(store.verifyAll([{ ...a, id: 'e'.repeat(64) }])).rejects.toThrow(/missing or invalid/)
    await expect(store.verifyAll('nope')).rejects.toThrow(AttachmentError)
  })

  it('prune removes unreferenced old files and keeps referenced and fresh ones', async () => {
    const keep = await store.save(PNG, 'keep.png')
    const old = await store.save(JPG, 'old.jpg')
    const fresh = await store.save(GIF, 'fresh.gif')
    const past = new Date(Date.now() - 3 * 3600_000)
    for (const f of readdirSync(store.dir)) if (!f.startsWith(fresh.id)) utimesSync(path.join(store.dir, f), past, past)
    writeFileSync(path.join(store.dir, 'leftover.tmp'), 'x')
    expect(await store.prune(new Set([keep.id]))).toBe(2) // old + tmp
    expect(readdirSync(store.dir).sort()).toEqual([`${fresh.id}.gif`, `${keep.id}.png`].sort())
    expect(old.id).not.toBe(keep.id)
    expect(await new AttachmentStore(path.join(dir, 'nowhere')).prune(new Set())).toBe(0)
  })
})

describe('wire formats with images', () => {
  const att: Attachment = { id: 'a'.repeat(64), name: 'cat.png', mime: 'image/png', size: 4 }
  const user = (over: Partial<Message> = {}): Message => ({ id: 'u', role: 'user', content: 'what is this?', createdAt: 1, attachments: [att], ...over })
  const images = new Map([[att.id, 'QUJD']])

  it('OpenAI: image_url data URL parts before the text', () => {
    expect(toWire([user()], images)).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: 'what is this?' }] }
    ])
  })

  it('OpenAI: image-only message has no empty text part', () => {
    expect(toWire([user({ content: '' })], images)[0].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }])
  })

  it('OpenAI: a missing file is mentioned instead of dropped', () => {
    expect(toWire([user()], new Map())).toEqual([{ role: 'user', content: [{ type: 'text', text: 'what is this?\n[image unavailable: cat.png]' }] }])
  })

  it('OpenAI: messages without images are unchanged plain strings', () => {
    expect(toWire([user({ attachments: undefined })])).toEqual([{ role: 'user', content: 'what is this?' }])
  })

  it('Anthropic: base64 image block before the text', () => {
    expect(toAnthropicMessages([user()], images)).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'what is this?' }] }
    ])
  })

  it('Anthropic: missing file note, and image-only messages are kept', () => {
    expect(toAnthropicMessages([user()], new Map())[0].content).toEqual([{ type: 'text', text: 'what is this?\n[image unavailable: cat.png]' }])
    expect((toAnthropicMessages([user({ content: '' })], images)[0].content as unknown[]).length).toBe(1)
  })

  it('a /skill invocation still applies to a message with images', () => {
    const w = toWire([user({ content: '/review look', skill: { name: 'review', text: 'Be careful.' } })], images)
    const parts = w[0].content as { type: string; text?: string }[]
    expect(parts[1].text).toContain('Be careful.')
  })
})
