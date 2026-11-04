// Types shared by main, preload and renderer. Keep this file dependency-free.

export const APP_NAME = 'Talaria' // working title — change in one place

export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  /** Model that produced an assistant message. */
  model?: string
  /** Set when generation failed or was interrupted. */
  error?: string
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

export interface Settings {
  providers: Provider[]
  activeProviderId: string
  systemPrompt: string
  temperature: number
  theme: ThemeSetting
}

export type SettingsPatch = Partial<Omit<Settings, 'providers'>>

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
    onEvent(cb: (e: ChatEvent) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    saveProvider(input: ProviderInput): Promise<Settings>
    removeProvider(id: string): Promise<Settings>
  }
  models: {
    list(providerId: string): Promise<ConnectionResult>
    /** Test arbitrary (possibly unsaved) connection details. */
    test(baseUrl: string, apiKey: string | undefined, providerId?: string): Promise<ConnectionResult>
  }
}
