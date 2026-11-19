import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ATTACHMENT_ID, cleanName, IMAGE_EXT, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, sniffImage } from '../shared/attachments'
import type { Attachment } from '../shared/types'

export class AttachmentError extends Error {}

/**
 * Image files for chat messages, stored by content hash (`<sha256>.<ext>`) so duplicates cost nothing and
 * conversations only ever reference an id. The renderer never gets a file path — only bytes via data URLs.
 */
export class AttachmentStore {
  constructor(readonly dir: string) {}

  private file(a: Pick<Attachment, 'id' | 'mime'>): string {
    return path.join(this.dir, `${a.id}.${IMAGE_EXT[a.mime]}`)
  }

  async save(bytes: Uint8Array, name: string): Promise<Attachment> {
    if (!bytes.length) throw new AttachmentError('That file is empty.')
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`Images must be under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB (this one is ${(bytes.length / 1024 / 1024).toFixed(1)} MB).`)
    const mime = sniffImage(bytes)
    if (!mime) throw new AttachmentError('Only PNG, JPEG, GIF and WebP images are supported.')
    const id = createHash('sha256').update(bytes).digest('hex')
    await fs.mkdir(this.dir, { recursive: true })
    const target = this.file({ id, mime })
    try {
      await fs.access(target)
    } catch {
      const tmp = `${target}.${process.pid}.tmp`
      await fs.writeFile(tmp, bytes, { mode: 0o600 })
      await fs.rename(tmp, target)
    }
    return { id, name: cleanName(name, mime), mime, size: bytes.length }
  }

  /** Re-validate an attachment descriptor sent by the renderer against what is actually on disk. */
  async verify(a: Attachment): Promise<Attachment | null> {
    if (!a || typeof a.id !== 'string' || !ATTACHMENT_ID.test(a.id) || !IMAGE_MIMES.includes(a.mime)) return null
    try {
      const buf = await fs.readFile(this.file(a))
      if (sniffImage(buf) !== a.mime) return null
      return { id: a.id, name: cleanName(String(a.name ?? ''), a.mime), mime: a.mime, size: buf.length }
    } catch {
      return null
    }
  }

  /** Verify a list from the renderer: drops duplicates, rejects anything unknown or over the limit. */
  async verifyAll(list: unknown): Promise<Attachment[]> {
    if (list === undefined || list === null) return []
    if (!Array.isArray(list)) throw new AttachmentError('Invalid attachments.')
    if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AttachmentError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`)
    const out: Attachment[] = []
    for (const raw of list) {
      const ok = await this.verify(raw)
      if (!ok) throw new AttachmentError('One of the attached images is missing or invalid. Attach it again.')
      if (!out.some((x) => x.id === ok.id)) out.push(ok)
    }
    return out
  }

  async read(a: Attachment): Promise<Buffer | null> {
    if (!ATTACHMENT_ID.test(a.id) || !IMAGE_MIMES.includes(a.mime)) return null
    try {
      const buf = await fs.readFile(this.file(a))
      return sniffImage(buf) === a.mime ? buf : null
    } catch {
      return null
    }
  }

  async dataUrl(a: Attachment): Promise<string | null> {
    const buf = await this.read(a)
    return buf ? `data:${a.mime};base64,${buf.toString('base64')}` : null
  }

  /** Delete files no conversation references (and that aren't brand new — a draft may be attached but not sent yet). */
  async prune(referenced: Set<string>, minAgeMs = 60 * 60 * 1000): Promise<number> {
    let removed = 0
    let names: string[] = []
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return 0
    }
    for (const n of names) {
      const id = n.split('.')[0]
      if (ATTACHMENT_ID.test(id) && referenced.has(id)) continue
      const file = path.join(this.dir, n)
      try {
        const st = await fs.stat(file)
        if (Date.now() - st.mtimeMs < minAgeMs && !n.endsWith('.tmp')) continue
        await fs.rm(file, { force: true })
        removed++
      } catch {
        /* ignore */
      }
    }
    return removed
  }
}
