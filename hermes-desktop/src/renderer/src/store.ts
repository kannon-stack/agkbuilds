import { create } from 'zustand'
import type { McpServerStatus } from '../../shared/mcp'
import { sanitizeAppearance, type Appearance } from '../../shared/theme'
import type { MemoryItem } from '../../shared/memory'
import type { SkillSummary } from '../../shared/skills'
import type { ThemeOverride } from './applyTheme'
import type {
  ChatEvent,
  ConnectionResult,
  SettingsPatch,
  Conversation,
  ConversationSummary,
  Settings,
  ToolDecision
} from '../../shared/types'

interface State {
  ready: boolean
  settings: Settings | null
  conversations: ConversationSummary[]
  active: Conversation | null
  /** Conversation ids with a response currently streaming. */
  generating: Record<string, boolean>
  models: ConnectionResult | null
  modelsLoading: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  memory: MemoryItem[]
  skills: SkillSummary[]
  /** Unsaved colours from the theme editor, applied live. */
  previewTheme: ThemeOverride | null
  mcpStatus: McpServerStatus[]
  toast: string | null

  init(): Promise<void>
  refreshList(): Promise<void>
  select(id: string): Promise<void>
  newChat(): Promise<void>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  send(text: string): Promise<void>
  regenerate(): Promise<void>
  stop(): Promise<void>
  decide(callId: string, decision: ToolDecision): Promise<void>
  setModel(providerId: string, model: string): Promise<void>
  loadModels(providerId?: string): Promise<void>
  applyEvent(e: ChatEvent): void
  setSettings(s: Settings): void
  openSettings(open: boolean, tab?: SettingsTab): void
  refreshMemory(): Promise<void>
  refreshSkills(): Promise<void>
  refreshSettings(): Promise<void>
  /** Apply a settings change in the UI immediately, then persist it (UI keeps the saved result). */
  patchSettings(patch: SettingsPatch): Promise<void>
  setPreviewTheme(p: ThemeOverride | null): void
  /** Apply an appearance change instantly and persist it (debounced). */
  updateAppearance(patch: Partial<Appearance>): void
  showToast(msg: string): void
}

export type SettingsTab = 'providers' | 'general' | 'tools' | 'mcp' | 'appearance' | 'memory' | 'skills'

let toastTimer: ReturnType<typeof setTimeout> | undefined
let appearanceTimer: ReturnType<typeof setTimeout> | undefined
let pendingAppearance: Partial<Appearance> = {}

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  conversations: [],
  active: null,
  generating: {},
  models: null,
  modelsLoading: false,
  settingsOpen: false,
  settingsTab: 'providers',
  memory: [],
  skills: [],
  previewTheme: null,
  mcpStatus: [],
  toast: null,

  async init() {
    const api = window.api
    api.chat.onEvent((e) => get().applyEvent(e))
    api.mcp.onStatus((mcpStatus) => set({ mcpStatus }))
    void api.mcp.status().then((mcpStatus) => set({ mcpStatus }))
    api.onDataChanged((kind) => void (kind === 'memory' ? get().refreshMemory() : get().refreshSkills()))
    void get().refreshMemory()
    void get().refreshSkills()
    const [settings, conversations] = await Promise.all([api.settings.get(), api.conversations.list()])
    set({ settings, conversations, ready: true })
    // Open the most recent chat, or a fresh one.
    if (conversations[0]) await get().select(conversations[0].id)
    else set({ active: await api.conversations.create() })
    void get().loadModels()
  },

  async refreshList() {
    set({ conversations: await window.api.conversations.list() })
  },

  async select(id) {
    const c = await window.api.conversations.get(id)
    if (c) set({ active: c })
  },

  async newChat() {
    const { active } = get()
    // Reuse the current draft instead of piling up empty chats.
    if (active && active.messages.length === 0) return
    const c = await window.api.conversations.create()
    set({ active: c })
  },

  async remove(id) {
    await window.api.conversations.remove(id)
    const { active } = get()
    await get().refreshList()
    if (active?.id === id) {
      const next = get().conversations[0]
      if (next) await get().select(next.id)
      else set({ active: await window.api.conversations.create() })
    }
  },

  async rename(id, title) {
    await window.api.conversations.rename(id, title)
    await get().refreshList()
    const { active } = get()
    if (active?.id === id) set({ active: { ...active, title } })
  },

  async send(text) {
    const { active, settings } = get()
    if (!active || !settings || get().generating[active.id]) return
    const { providerId, model } = effectiveModel(get())
    set((s) => ({ generating: { ...s.generating, [active.id]: true } }))
    try {
      const conv = await window.api.chat.send({ conversationId: active.id, content: text, providerId, model })
      set({ active: conv })
      void get().refreshList()
    } catch (e) {
      set((s) => ({ generating: { ...s.generating, [active.id]: false } }))
      get().showToast((e as Error).message)
    }
  },

  async regenerate() {
    const { active } = get()
    if (!active || get().generating[active.id]) return
    const { providerId, model } = effectiveModel(get())
    set((s) => ({ generating: { ...s.generating, [active.id]: true } }))
    try {
      const conv = await window.api.chat.regenerate({ conversationId: active.id, providerId, model })
      set({ active: conv })
    } catch (e) {
      set((s) => ({ generating: { ...s.generating, [active.id]: false } }))
      get().showToast((e as Error).message)
    }
  },

  async stop() {
    const { active } = get()
    if (active) await window.api.chat.stop(active.id)
  },

  async decide(callId, decision) {
    // Optimistic: the card leaves the "needs approval" state immediately.
    const { active } = get()
    if (active) {
      set({
        active: {
          ...active,
          messages: active.messages.map((m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((c) =>
              c.id === callId ? { ...c, status: decision === 'deny' ? ('denied' as const) : ('running' as const) } : c
            )
          }))
        }
      })
    }
    await window.api.chat.decide(callId, decision)
  },

  async setModel(providerId, model) {
    const { active, settings } = get()
    if (!active || !settings) return
    await window.api.conversations.setModel(active.id, providerId, model)
    set({ active: { ...active, providerId, model } })
    // Remember as the default for new chats.
    const p = settings.providers.find((x) => x.id === providerId)
    if (p) {
      await window.api.settings.update({ activeProviderId: providerId })
      const next = await window.api.settings.saveProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        defaultModel: model
      })
      set({ settings: next })
    }
  },

  async loadModels(providerId) {
    const { settings, active } = get()
    const id = providerId ?? active?.providerId ?? settings?.activeProviderId
    if (!id) return
    set({ modelsLoading: true })
    const models = await window.api.models.list(id)
    set({ models, modelsLoading: false })
  },

  applyEvent(e) {
    const { active } = get()
    if (e.type === 'start') {
      set((s) => ({ generating: { ...s.generating, [e.conversationId]: true } }))
      if (active?.id === e.conversationId && !active.messages.some((m) => m.id === e.messageId)) {
        set({
          active: {
            ...active,
            messages: [
              ...active.messages,
              { id: e.messageId, role: 'assistant', content: '', createdAt: Date.now() }
            ]
          }
        })
      }
      return
    }
    if (active?.id === e.conversationId) {
      const messages = active.messages.map((m) => {
        if (m.id !== e.messageId) return m
        if (e.type === 'tool_update') {
          const calls = m.toolCalls ?? []
          const exists = calls.some((c) => c.id === e.call.id)
          return { ...m, toolCalls: exists ? calls.map((c) => (c.id === e.call.id ? e.call : c)) : [...calls, e.call] }
        }
        if (e.type === 'delta') return { ...m, content: m.content + e.text }
        if (e.type === 'thinking') return { ...m, thinking: (m.thinking ?? '') + e.text }
        if (e.type === 'meta') return { ...m, usage: e.usage, servedBy: e.servedBy }
        if (e.type === 'error') return { ...m, error: e.error }
        return m
      })
      set({ active: { ...active, messages } })
    }
    if (e.type === 'done' || e.type === 'error') {
      set((s) => ({ generating: { ...s.generating, [e.conversationId]: false } }))
      void get().refreshList()
    }
  },

  setSettings(settings) {
    set({ settings })
  },
  async refreshMemory() {
    set({ memory: await window.api.memory.list() })
  },
  async refreshSkills() {
    set({ skills: await window.api.skills.list() })
  },
  async patchSettings(patch) {
    const cur = get().settings
    if (cur) {
      set({
        settings: {
          ...cur,
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.memory ? { memory: { ...cur.memory, ...patch.memory } } : {}),
          ...(patch.skills ? { skills: { ...cur.skills, ...patch.skills } } : {}),
          ...(patch.tools ? { tools: { ...cur.tools, ...patch.tools, policies: { ...cur.tools.policies, ...(patch.tools.policies ?? {}) } } } : {})
        }
      })
    }
    const saved = await window.api.settings.update(patch)
    // Keep the appearance the user may have edited meanwhile (it has its own debounced save).
    set((s) => ({ settings: s.settings ? { ...saved, appearance: s.settings.appearance } : saved }))
  },
  async refreshSettings() {
    set({ settings: await window.api.settings.get() })
  },
  setPreviewTheme(previewTheme) {
    set({ previewTheme })
  },
  updateAppearance(patch) {
    const { settings } = get()
    if (!settings) return
    // Optimistic: same validation as the main process, so what you see is what gets saved.
    set({ settings: { ...settings, appearance: sanitizeAppearance(patch, settings.appearance) } })
    pendingAppearance = { ...pendingAppearance, ...patch }
    clearTimeout(appearanceTimer)
    appearanceTimer = setTimeout(async () => {
      const toSend = pendingAppearance
      pendingAppearance = {}
      const saved = await window.api.settings.update({ appearance: toSend })
      // Keep newer optimistic edits made while the request was in flight.
      if (!Object.keys(pendingAppearance).length) set({ settings: saved })
    }, 250)
  },
  openSettings(open, tab) {
    set((s) => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab }))
  },
  showToast(msg) {
    clearTimeout(toastTimer)
    set({ toast: msg })
    toastTimer = setTimeout(() => set({ toast: null }), 4000)
  }
}))

/** Provider/model for the active conversation, falling back to settings defaults. */
export function effectiveModel(s: Pick<State, 'active' | 'settings'>) {
  const settings = s.settings
  const providerId = s.active?.providerId ?? settings?.activeProviderId ?? ''
  const provider = settings?.providers.find((p) => p.id === providerId) ?? settings?.providers[0]
  const model = s.active?.model || provider?.defaultModel || ''
  return { providerId: provider?.id ?? providerId, provider, model }
}
