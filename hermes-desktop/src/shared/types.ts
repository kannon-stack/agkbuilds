// Types shared by main, preload and renderer. Keep this file dependency-free.

import type { ToolPolicy } from './toolMeta'
import type { AnthropicOptions, ProviderKind, UsageInfo } from './anthropic'
import type { Appearance, Mode } from './theme'
import type { MemoryItem } from './memory'
import type { SkillFull, SkillInput, SkillSummary, SkillsSettings } from './skills'
import type { McpImportResult, McpServer, McpServerInput, McpServerStatus } from './mcp'

export const APP_NAME = 'Talaria' // working title — change in one place
/** Reverse-DNS app id (Windows taskbar grouping, macOS bundle id). Keep in sync with electron-builder.config.js. */
export const APP_ID = 'dev.talaria.desktop'

export type Role = 'system' | 'user' | 'assistant'

export type ToolStatus = 'awaiting_approval' | 'running' | 'done' | 'error' | 'denied'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
  status: ToolStatus
  /** Human-readable one-liner, e.g. "$ ls -la". */
  summary?: string
  /** Extra context for the approval card (e.g. the text of the memory about to be forgotten). */
  detail?: string
  /** Display name, e.g. "Run shell commands" or "github · create_issue". */
  label?: string
  /** True for tools provided by an external MCP server. */
  external?: boolean
  /** Text returned to the model (and shown in the UI). */
  result?: string
}

export type ToolDecision = 'allow' | 'allow_chat' | 'deny'

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  /** Model that produced an assistant message. */
  model?: string
  /** Set when generation failed or was interrupted. */
  error?: string
  /** Tool calls the assistant made in this turn (with their results). */
  toolCalls?: ToolCall[]
  /** Readable reasoning summary (Claude, when enabled). */
  thinking?: string
  /** Provider-native response blocks, replayed verbatim on later turns (Claude: thinking blocks carry signatures that must round-trip). */
  raw?: unknown[]
  usage?: UsageInfo
  /** Set when a refusal fallback model produced this answer. */
  servedBy?: string
  /** User message that invoked a skill with /name — instructions are snapshotted so history stays reproducible. */
  skill?: { name: string; text: string }
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  packaged: boolean
  dataDir: string
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string }

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  providerId?: string
  model?: string
  /** Per-conversation override of the global system prompt. */
  systemPrompt?: string
}

export type ConversationSummary = Pick<
  Conversation,
  'id' | 'title' | 'createdAt' | 'updatedAt'
> & { preview: string }

/** Provider as stored on disk (main process only). */
export interface ProviderRecord {
  id: string
  name: string
  /** Wire protocol: generic OpenAI-compatible, or the native Anthropic Messages API. */
  kind: ProviderKind
  /** Claude-specific settings (kind === 'anthropic'). */
  options?: AnthropicOptions
  /** OpenAI-compatible base URL, e.g. http://localhost:20128/v1 */
  baseUrl: string
  defaultModel: string
  /** Encrypted (safeStorage) or plain API key, main process only. */
  apiKey?: { encrypted: boolean; value: string }
}

/** Provider as exposed to the renderer: never includes the key itself. */
export type Provider = Omit<ProviderRecord, 'apiKey'> & {
  hasKey: boolean
  /** True when a key is saved unencrypted (no OS keychain available). */
  keyPlain: boolean
}

export type ThemeSetting = Mode

export interface ToolSettings {
  enabled: boolean
  /** Absolute path of the folder file/command tools operate in ('' = none chosen). */
  workspace: string
  policies: Record<string, ToolPolicy>
}

export interface Settings {
  providers: Provider[]
  activeProviderId: string
  systemPrompt: string
  temperature: number
  theme: ThemeSetting
  tools: ToolSettings
  mcpServers: McpServer[]
  appearance: Appearance
  memory: MemorySettings
  skills: SkillsSettings
}

export interface MemorySettings {
  /** Inject saved notes into the system prompt (and let the model use remember/forget). */
  enabled: boolean
}

export type SettingsPatch = Partial<Omit<Settings, 'providers' | 'tools' | 'mcpServers' | 'appearance' | 'memory' | 'skills'>> & {
  tools?: Partial<ToolSettings>
  appearance?: Partial<Appearance>
  memory?: Partial<MemorySettings>
  skills?: Partial<SkillsSettings>
}

export interface ProviderInput {
  id?: string
  name: string
  kind?: ProviderKind
  options?: AnthropicOptions
  baseUrl: string
  defaultModel: string
  /** undefined = leave key unchanged, '' = clear it. */
  apiKey?: string
}

export interface SendRequest {
  conversationId: string
  content: string
  providerId?: string
  model?: string
}

export interface RegenerateRequest {
  conversationId: string
  providerId?: string
  model?: string
}

export type ChatEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; conversationId: string; messageId: string; text: string }
  | { type: 'thinking'; conversationId: string; messageId: string; text: string }
  | { type: 'meta'; conversationId: string; messageId: string; usage?: UsageInfo; servedBy?: string }
  /** A tool call was created or changed state (approval, running, result). */
  | { type: 'tool_update'; conversationId: string; messageId: string; call: ToolCall }
  | { type: 'done'; conversationId: string; messageId: string }
  | { type: 'error'; conversationId: string; messageId: string; error: string }

export interface ConnectionResult {
  ok: boolean
  models: string[]
  error?: string
}

/** The API surface the preload script exposes as `window.api`. */
export interface Api {
  conversations: {
    list(): Promise<ConversationSummary[]>
    get(id: string): Promise<Conversation | null>
    create(): Promise<Conversation>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    setModel(id: string, providerId: string, model: string): Promise<void>
  }
  chat: {
    send(req: SendRequest): Promise<Conversation>
    regenerate(req: RegenerateRequest): Promise<Conversation>
    stop(conversationId: string): Promise<void>
    /** Answer a pending tool-approval prompt. */
    decide(callId: string, decision: ToolDecision): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    saveProvider(input: ProviderInput): Promise<Settings>
    removeProvider(id: string): Promise<Settings>
    /** Opens a native folder picker; returns null if cancelled. */
    pickWorkspace(): Promise<string | null>
  }
  memory: {
    list(): Promise<MemoryItem[]>
    add(text: string, scope: 'global' | 'project'): Promise<Result<MemoryItem>>
    update(id: string, patch: { text?: string; enabled?: boolean }): Promise<Result<MemoryItem>>
    remove(id: string): Promise<Result>
    clear(): Promise<number>
  }
  skills: {
    list(): Promise<SkillSummary[]>
    get(name: string): Promise<SkillFull | null>
    save(input: SkillInput): Promise<Result<SkillSummary>>
    remove(name: string): Promise<Result>
    setEnabled(name: string, enabled: boolean): Promise<Result>
    /** Pick a skill folder with the native dialog and copy it into your skills. */
    importFolder(): Promise<Result<SkillSummary> | null>
    openFolder(): Promise<void>
  }
  /** Fired when memory or skills change behind the UI's back (e.g. the model saved a note). */
  onDataChanged(cb: (kind: 'memory' | 'skills') => void): () => void
  app: {
    info(): Promise<AppInfo>
    openDataFolder(): Promise<void>
    /** Renderer has applied the theme — the (hidden) window may now be shown. */
    rendered(): Promise<void>
  }
  mcp: {
    status(): Promise<McpServerStatus[]>
    save(input: McpServerInput): Promise<Settings>
    remove(id: string): Promise<Settings>
    restart(id: string): Promise<void>
    /** Remote servers: start the browser sign-in / forget the stored sign-in / abort a pending one / re-open its page. */
    signIn(id: string): Promise<void>
    signOut(id: string): Promise<void>
    cancelAuth(id: string): Promise<void>
    reopenAuth(id: string): Promise<void>
    /** Parse a pasted `{ "mcpServers": {...} }` config (Claude Desktop / Cursor format). */
    parseImport(text: string): Promise<McpImportResult>
    onStatus(cb: (s: McpServerStatus[]) => void): () => void
  }
  models: {
    list(providerId: string): Promise<ConnectionResult>
    /** Test arbitrary (possibly unsaved) connection details. */
    test(baseUrl: string, apiKey: string | undefined, providerId?: string, kind?: ProviderKind): Promise<ConnectionResult>
  }
}
