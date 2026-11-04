import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Conversation,
  ConversationSummary,
  Provider,
  ProviderInput,
  ProviderRecord,
  Settings,
  SettingsPatch,
  ThemeSetting
} from '../shared/types'

/**
 * File-backed storage. One JSON file per conversation + settings.json.
 * Deliberately behind a small interface so it can be swapped for SQLite later
 * (full-text search, memory/skills) without touching IPC or the renderer.
 */

interface SettingsFile {
  providers: ProviderRecord[]
  activeProviderId: string
  systemPrompt: string
  temperature: number
  theme: ThemeSetting
}

const DEFAULT_PROVIDER: ProviderRecord = {
  id: 'default',
  name: '9router (local)',
  baseUrl: 'http://localhost:20128/v1',
  defaultModel: ''
}

const DEFAULTS: SettingsFile = {
  providers: [DEFAULT_PROVIDER],
  activeProviderId: DEFAULT_PROVIDER.id,
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  theme: 'system'
}

let root = ''
const convDir = () => path.join(root, 'conversations')
const settingsPath = () => path.join(root, 'settings.json')

export async function initStore(dir = app.getPath('userData')): Promise<void> {
  root = dir
  await fs.mkdir(convDir(), { recursive: true })
}

/** Atomic write: tmp file + rename, so a crash never leaves half a file. */
async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  // 0600: settings.json may hold an API key; keep it owner-only.
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, file)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error(`[store] failed to read ${file}:`, e)
    return null
  }
}

// ---------- API key handling (main process only) ----------

function encryptKey(plain: string): NonNullable<ProviderRecord['apiKey']> {
  if (safeStorage.isEncryptionAvailable()) {
    return { encrypted: true, value: safeStorage.encryptString(plain).toString('base64') }
  }
  return { encrypted: false, value: plain }
}

export function decryptKey(rec: ProviderRecord): string | undefined {
  if (!rec.apiKey) return undefined
  if (!rec.apiKey.encrypted) return rec.apiKey.value
  try {
    return safeStorage.decryptString(Buffer.from(rec.apiKey.value, 'base64'))
  } catch {
    return undefined
  }
}

// ---------- Settings ----------

async function loadSettingsFile(): Promise<SettingsFile> {
  const f = await readJson<Partial<SettingsFile>>(settingsPath())
  const merged: SettingsFile = { ...DEFAULTS, ...(f ?? {}) }
  if (!merged.providers?.length) merged.providers = [DEFAULT_PROVIDER]
  if (!merged.providers.some((p) => p.id === merged.activeProviderId)) {
    merged.activeProviderId = merged.providers[0].id
  }
  return merged
}

const toPublic = (p: ProviderRecord): Provider => {
  const { apiKey, ...rest } = p
  return { ...rest, hasKey: !!apiKey?.value, keyPlain: !!apiKey?.value && !apiKey.encrypted }
}

function toSettings(f: SettingsFile): Settings {
  return { ...f, providers: f.providers.map(toPublic) }
}

export async function getSettings(): Promise<Settings> {
  return toSettings(await loadSettingsFile())
}

export async function getProviderRecord(id: string): Promise<ProviderRecord | undefined> {
  const f = await loadSettingsFile()
  return f.providers.find((p) => p.id === id) ?? f.providers[0]
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const f = await loadSettingsFile()
  const next: SettingsFile = { ...f }
  if (patch.activeProviderId !== undefined && f.providers.some((p) => p.id === patch.activeProviderId)) {
    next.activeProviderId = patch.activeProviderId
  }
  if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt
  if (patch.temperature !== undefined) next.temperature = Math.min(2, Math.max(0, patch.temperature))
  if (patch.theme !== undefined) next.theme = patch.theme
  await writeJson(settingsPath(), next)
  return toSettings(next)
}

export async function saveProvider(input: ProviderInput): Promise<Settings> {
  const f = await loadSettingsFile()
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const existing = input.id ? f.providers.find((p) => p.id === input.id) : undefined
  const rec: ProviderRecord = existing ?? {
    id: randomUUID(),
    name: '',
    baseUrl: '',
    defaultModel: ''
  }
  rec.name = input.name.trim() || 'Untitled provider'
  rec.baseUrl = baseUrl
  rec.defaultModel = input.defaultModel.trim()
  if (input.apiKey !== undefined) {
    rec.apiKey = input.apiKey ? encryptKey(input.apiKey) : undefined
  }
  if (!existing) f.providers.push(rec)
  await writeJson(settingsPath(), f)
  return toSettings(f)
}

export async function removeProvider(id: string): Promise<Settings> {
  const f = await loadSettingsFile()
  if (f.providers.length > 1) {
    f.providers = f.providers.filter((p) => p.id !== id)
    if (f.activeProviderId === id) f.activeProviderId = f.providers[0].id
    await writeJson(settingsPath(), f)
  }
  return toSettings(f)
}

// ---------- Conversations ----------

const convPath = (id: string) => path.join(convDir(), `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`)

export async function getConversation(id: string): Promise<Conversation | null> {
  return readJson<Conversation>(convPath(id))
}

export async function saveConversation(c: Conversation): Promise<void> {
  c.updatedAt = Date.now()
  await writeJson(convPath(c.id), c)
}

export async function createConversation(): Promise<Conversation> {
  const now = Date.now()
  const c: Conversation = { id: randomUUID(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] }
  await saveConversation(c)
  return c
}

export async function deleteConversation(id: string): Promise<void> {
  await fs.rm(convPath(id), { force: true })
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const files = await fs.readdir(convDir())
  const out: ConversationSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const c = await readJson<Conversation>(path.join(convDir(), f))
    if (!c || c.messages.length === 0) continue // empty drafts aren't listed
    const last = [...c.messages].reverse().find((m) => m.content)
    out.push({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      preview: (last?.content ?? '').slice(0, 120)
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Remove never-used empty drafts left behind by earlier sessions. */
export async function pruneEmptyConversations(): Promise<void> {
  for (const f of await fs.readdir(convDir())) {
    if (!f.endsWith('.json')) continue
    const file = path.join(convDir(), f)
    const c = await readJson<Conversation>(file)
    if (c && c.messages.length === 0) await fs.rm(file, { force: true })
  }
}
