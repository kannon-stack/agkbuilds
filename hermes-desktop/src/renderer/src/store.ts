import { create } from 'zustand'
import type {
  ChatEvent,
  ConnectionResult,
  Conversation,
  ConversationSummary,
  Settings
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
  setModel(providerId: string, model: string): Promise<void>
  loadModels(providerId?: string): Promise<void>
  applyEvent(e: ChatEvent): void
  setSettings(s: Settings): void
  openSettings(open: boolean): void
  showToast(msg: string): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  conversations: [],
  active: null,
  generating: {},
  models: null,
  modelsLoading: false,
  settingsOpen: false,
  toast: null,

  async init() {
    const api = window.api
    api.chat.onEvent((e) => get().applyEvent(e))
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
        if (e.type === 'delta') return { ...m, content: m.content + e.text }
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
  openSettings(open) {
    set({ settingsOpen: open })
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
