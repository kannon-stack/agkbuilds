// Types shared by main, preload and renderer. Keep this file dependency-free.

import type { ToolPolicy } from './toolMeta'
import type { McpImportResult, McpServer, McpServerInput, McpServerStatus } from './mcp'

export const APP_NAME = 'Talaria' // working title — change in one place

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
}

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

export type ThemeSetting = 'system' | 'dark' | 'light'

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
}

export type SettingsPatch = Partial<Omit<Settings, 'providers' | 'tools' | 'mcpServers'>> & {
  tools?: Partial<ToolSettings>
}

export interface ProviderInput {
  id?: string
  name: string
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
  mcp: {
    status(): Promise<McpServerStatus[]>
    save(input: McpServerInput): Promise<Settings>
    remove(id: string): Promise<Settings>
    restart(id: string): Promise<void>
    /** Parse a pasted `{ "mcpServers": {...} }` config (Claude Desktop / Cursor format). */
    parseImport(text: string): Promise<McpImportResult>
    onStatus(cb: (s: McpServerStatus[]) => void): () => void
  }
  models: {
    list(providerId: string): Promise<ConnectionResult>
    /** Test arbitrary (possibly unsaved) connection details. */
    test(baseUrl: string, apiKey: string | undefined, providerId?: string): Promise<ConnectionResult>
  }
}
