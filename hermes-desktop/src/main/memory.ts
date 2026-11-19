import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS, looksLikeSecret, normalizeMemory, oneLine,
  type MemoryItem, type MemorySource
} from '../shared/memory'

/** A problem the user/model should be told about (bad input, limits), not a crash. */
export class MemoryError extends Error {}

const newId = () => randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toLowerCase()

/**
 * File-backed memory (`memory.json`). All operations are serialized so the UI and the model's
 * tools can't interleave read-modify-write cycles and lose an update.
 */
export class MemoryStore {
  private cache: MemoryItem[] | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private file: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private async load(): Promise<MemoryItem[]> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = [])
      throw e
    }
    try {
      const j = JSON.parse(raw)
      const arr: unknown[] = Array.isArray(j?.items) ? j.items : []
      this.cache = arr.flatMap((x): MemoryItem[] => {
        const i = x as Partial<MemoryItem>
        if (!i || typeof i.id !== 'string' || typeof i.text !== 'string' || !i.text.trim()) return []
        return [{
          id: i.id, text: i.text.slice(0, MEMORY_MAX_CHARS), createdAt: Number(i.createdAt) || Date.now(), updatedAt: Number(i.updatedAt) || Date.now(),
          source: i.source === 'model' ? 'model' : 'user', enabled: i.enabled !== false, workspace: typeof i.workspace === 'string' && i.workspace ? i.workspace : undefined
        }]
      })
    } catch {
      // Never silently discard someone's notes: keep the unreadable file aside and start fresh.
      const aside = `${this.file}.corrupt-${Date.now()}`
      await fs.rename(this.file, aside).catch(() => {})
      console.error(`[memory] ${this.file} was unreadable; moved to ${aside}`)
      this.cache = []
    }
    return this.cache!
  }

  private async persist(items: MemoryItem[]): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
    this.cache = items
  }

  static validate(text: unknown): string {
    const t = typeof text === 'string' ? oneLine(text) : ''
    if (!t) throw new MemoryError('Nothing to remember: the text is empty.')
    if (t.length > MEMORY_MAX_CHARS) throw new MemoryError(`That is too long for a memory (${t.length} > ${MEMORY_MAX_CHARS} characters). Store a short, self-contained fact.`)
    const secret = looksLikeSecret(t)
    if (secret) throw new MemoryError(`That looks like ${secret}. Memory is stored unencrypted, so secrets are never saved.`)
    return t
  }

  list(): Promise<MemoryItem[]> {
    return this.serial(async () => [...(await this.load())])
  }

  /** Adds a note; an exact duplicate (ignoring case/punctuation) returns the existing one. */
  add(text: string, opts: { source: MemorySource; workspace?: string }): Promise<{ item: MemoryItem; duplicate: boolean }> {
    return this.serial(async () => {
      const t = MemoryStore.validate(text)
      const items = await this.load()
      const key = normalizeMemory(t)
      const dup = items.find((i) => normalizeMemory(i.text) === key && (i.workspace ?? '') === (opts.workspace ?? ''))
      if (dup) return { item: dup, duplicate: true }
      if (items.length >= MEMORY_MAX_ITEMS) throw new MemoryError(`Memory is full (${MEMORY_MAX_ITEMS} notes). Forget some old ones first.`)
      const now = Date.now()
      let id = newId()
      while (items.some((i) => i.id === id)) id = newId()
      const item: MemoryItem = { id, text: t, createdAt: now, updatedAt: now, source: opts.source, enabled: true, workspace: opts.workspace || undefined }
      await this.persist([item, ...items])
      return { item, duplicate: false }
    })
  }

  update(id: string, patch: { text?: string; enabled?: boolean }): Promise<MemoryItem> {
    return this.serial(async () => {
      const items = await this.load()
      const cur = items.find((i) => i.id === id)
      if (!cur) throw new MemoryError(`No memory with id "${id}".`)
      const next: MemoryItem = { ...cur, updatedAt: Date.now() }
      if (patch.text !== undefined) next.text = MemoryStore.validate(patch.text)
      if (patch.enabled !== undefined) next.enabled = !!patch.enabled
      await this.persist(items.map((i) => (i.id === id ? next : i)))
      return next
    })
  }

  remove(id: string): Promise<MemoryItem> {
    return this.serial(async () => {
      const items = await this.load()
      const cur = items.find((i) => i.id === id)
      if (!cur) throw new MemoryError(`No memory with id "${id}".`)
      await this.persist(items.filter((i) => i.id !== id))
      return cur
    })
  }

  clear(): Promise<number> {
    return this.serial(async () => {
      const n = (await this.load()).length
      await this.persist([])
      return n
    })
  }
}
