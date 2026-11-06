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
  ThemeSetting,
  ToolSettings
} from '../shared/types'
import type { McpServer, McpServerInput } from '../shared/mcp'
import type { MemorySettings } from '../shared/types'
import type { SkillsSettings } from '../shared/skills'
import { ANTHROPIC_BASE_URL, normalizeAnthropicOptions } from '../shared/anthropic'
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from '../shared/theme'

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
  tools: ToolSettings
  mcpServers: McpServerRecord[]
  appearance: Appearance
  memory: MemorySettings
  skills: SkillsSettings
}

const DEFAULT_PROVIDER: ProviderRecord = {
  id: 'default',
  name: '9router (local)',
  kind: 'openai',
  baseUrl: 'http://localhost:20128/v1',
  defaultModel: ''
}

const DEFAULTS: SettingsFile = {
  providers: [DEFAULT_PROVIDER],
  activeProviderId: DEFAULT_PROVIDER.id,
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  theme: 'system',
  tools: { enabled: true, workspace: '', policies: {} },
  mcpServers: [],
  appearance: DEFAULT_APPEARANCE,
  memory: { enabled: true },
  skills: { enabled: true, disabled: [], trusted: {} }
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

export type Secret = { encrypted: boolean; value: string }

function encryptKey(plain: string): Secret {
  if (safeStorage.isEncryptionAvailable()) {
    return { encrypted: true, value: safeStorage.encryptString(plain).toString('base64') }
  }
  return { encrypted: false, value: plain }
}

export const encryptSecret = (plain: string): Secret => encryptKey(plain)

export function decryptSecret(s?: Secret): string | undefined {
  if (!s) return undefined
  if (!s.encrypted) return s.value
  try {
    return safeStorage.decryptString(Buffer.from(s.value, 'base64'))
  } catch {
    return undefined
  }
}

export const decryptKey = (rec: ProviderRecord) => decryptSecret(rec.apiKey)

// ---------- MCP server records ----------

export interface McpServerRecord {
  id: string
  name: string
  enabled: boolean
  transport: McpServer['transport']
  command?: string
  args?: string[]
  url?: string
  env: Record<string, Secret>
  headers: Record<string, Secret>
  policy: McpServer['policy']
  toolPolicies: Record<string, McpServer['policy']>
  /** Optional pre-registered OAuth app for remote servers. */
  oauth?: { clientId?: string; clientSecret?: Secret; scope?: string }
}

// ---------- Settings ----------

async function loadSettingsFile(): Promise<SettingsFile> {
  const f = await readJson<Partial<SettingsFile>>(settingsPath())
  const merged: SettingsFile = { ...DEFAULTS, ...(f ?? {}) }
  // Providers saved before native Claude support have no `kind`: they are OpenAI-compatible.
  merged.providers = (f?.providers ?? merged.providers).map((p) => ({ ...p, kind: p.kind === 'anthropic' ? 'anthropic' : 'openai', ...(p.kind === 'anthropic' ? { options: normalizeAnthropicOptions(p.options) } : {}) }))
  merged.tools = { ...DEFAULTS.tools, ...(f?.tools ?? {}), policies: { ...(f?.tools?.policies ?? {}) } }
  merged.memory = { enabled: f?.memory?.enabled !== false }
  merged.skills = cleanSkills(f?.skills)
  // Re-validate on every load: the file may be hand-edited or from an older version.
  merged.appearance = sanitizeAppearance(f?.appearance, DEFAULT_APPEARANCE)
  merged.mcpServers = (f?.mcpServers ?? []).map((r) => ({ ...r, env: r.env ?? {}, headers: r.headers ?? {}, toolPolicies: r.toolPolicies ?? {} }))
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

const toPublicMcp = (r: McpServerRecord): McpServer => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  transport: r.transport,
  command: r.command,
  args: r.args,
  url: r.url,
  envKeys: Object.keys(r.env),
  headerKeys: Object.keys(r.headers),
  policy: r.policy,
  toolPolicies: r.toolPolicies,
  ...(r.oauth && (r.oauth.clientId || r.oauth.scope || r.oauth.clientSecret)
    ? { oauth: { clientId: r.oauth.clientId, hasClientSecret: !!r.oauth.clientSecret, scope: r.oauth.scope } }
    : {})
})

/** Normalise (possibly hand-edited) skill settings: arrays of names, name→hash map. */
function cleanSkills(raw: Partial<SkillsSettings> | undefined): SkillsSettings {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : [])
  const trusted: Record<string, string> = {}
  if (raw?.trusted && typeof raw.trusted === 'object') {
    for (const [k, v] of Object.entries(raw.trusted)) if (typeof v === 'string' && k.length <= 64) trusted[k] = v
  }
  return { enabled: raw?.enabled !== false, disabled: names(raw?.disabled), trusted }
}

function toSettings(f: SettingsFile): Settings {
  const { mcpServers, ...rest } = f
  return { ...rest, providers: f.providers.map(toPublic), mcpServers: mcpServers.map(toPublicMcp) }
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
  if (patch.memory?.enabled !== undefined) next.memory = { enabled: !!patch.memory.enabled }
  if (patch.skills) next.skills = cleanSkills({ ...f.skills, ...patch.skills })
  if (patch.appearance) next.appearance = sanitizeAppearance(patch.appearance, f.appearance)
  if (patch.tools) {
    next.tools = { ...f.tools, ...patch.tools, policies: { ...f.tools.policies, ...(patch.tools.policies ?? {}) } }
  }
  await writeJson(settingsPath(), next)
  return toSettings(next)
}

export async function saveProvider(input: ProviderInput): Promise<Settings> {
  const f = await loadSettingsFile()
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const existing = input.id ? f.providers.find((p) => p.id === input.id) : undefined
  const kind: ProviderRecord['kind'] = (input.kind ?? existing?.kind) === 'anthropic' ? 'anthropic' : 'openai'
  const rec: ProviderRecord = existing ?? {
    id: randomUUID(),
    name: '',
    kind,
    baseUrl: '',
    defaultModel: ''
  }
  rec.kind = kind
  rec.name = input.name.trim() || 'Untitled provider'
  rec.baseUrl = baseUrl || (rec.kind === 'anthropic' ? ANTHROPIC_BASE_URL : '')
  if (rec.kind === 'anthropic') rec.options = normalizeAnthropicOptions(input.options ?? rec.options)
  else delete rec.options
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

// ---------- MCP server CRUD ----------

export async function getMcpRecords(): Promise<McpServerRecord[]> {
  return (await loadSettingsFile()).mcpServers
}

function applySecrets(target: Record<string, Secret>, set?: Record<string, string>, remove?: string[]) {
  for (const k of remove ?? []) delete target[k]
  for (const [k, v] of Object.entries(set ?? {})) {
    const key = k.trim()
    if (key && v !== '') target[key] = encryptKey(v)
  }
}

export async function saveMcpServer(input: McpServerInput): Promise<Settings> {
  const f = await loadSettingsFile()
  const existing = input.id ? f.mcpServers.find((s) => s.id === input.id) : undefined
  const rec: McpServerRecord = existing ?? {
    id: randomUUID(), name: '', enabled: true, transport: input.transport, env: {}, headers: {}, policy: 'ask', toolPolicies: {}
  }
  rec.name = input.name.trim() || 'MCP server'
  rec.enabled = input.enabled
  rec.transport = input.transport
  rec.policy = input.policy
  if (input.toolPolicies) rec.toolPolicies = input.toolPolicies
  if (input.transport === 'stdio') {
    rec.command = input.command?.trim() ?? ''
    rec.args = (input.args ?? []).map(String)
    rec.url = undefined
  } else {
    rec.url = input.url?.trim() ?? ''
    rec.command = undefined
    rec.args = undefined
  }
  applySecrets(rec.env, input.envSet, input.envRemove)
  applySecrets(rec.headers, input.headersSet, input.headersRemove)
  if (input.transport === 'stdio') delete rec.oauth
  else if (input.oauth) {
    const o = { ...(rec.oauth ?? {}) }
    o.clientId = input.oauth.clientId?.trim() || undefined
    o.scope = input.oauth.scope?.trim().replace(/\s+/g, ' ') || undefined
    if (input.oauth.clientSecret !== undefined) o.clientSecret = input.oauth.clientSecret ? encryptKey(input.oauth.clientSecret) : undefined
    if (!o.clientId) delete o.clientSecret // a secret without an id is meaningless
    rec.oauth = o.clientId || o.scope ? o : undefined
    if (!rec.oauth) delete rec.oauth
  }
  if (!existing) f.mcpServers.push(rec)
  await writeJson(settingsPath(), f)
  return toSettings(f)
}

export async function removeMcpServer(id: string): Promise<Settings> {
  const f = await loadSettingsFile()
  f.mcpServers = f.mcpServers.filter((s) => s.id !== id)
  await writeJson(settingsPath(), f)
  return toSettings(f)
}
