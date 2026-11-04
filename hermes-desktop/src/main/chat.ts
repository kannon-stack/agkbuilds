import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { ChatEvent, Conversation, Message } from '../shared/types'
import { streamChat, type WireMessage } from './openai'
import { decryptKey, getConversation, getProviderRecord, getSettings, saveConversation } from './store'

/** Active generations, keyed by conversation id. One at a time per conversation. */
const active = new Map<string, AbortController>()

const emit = (wc: WebContents, e: ChatEvent) => {
  if (!wc.isDestroyed()) wc.send('chat:event', e)
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || 'New chat'
}

/** Persist the partial assistant text at most this often while streaming. */
const SAVE_EVERY_MS = 1500

async function generate(wc: WebContents, conv: Conversation, providerId?: string, model?: string) {
  const settings = await getSettings()
  const provider = await getProviderRecord(providerId ?? conv.providerId ?? settings.activeProviderId)
  const useModel = model ?? conv.model ?? provider?.defaultModel ?? ''

  const assistant: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    model: useModel
  }
  conv.messages.push(assistant)
  conv.providerId = provider?.id
  conv.model = useModel
  await saveConversation(conv)
  emit(wc, { type: 'start', conversationId: conv.id, messageId: assistant.id })

  const ctl = new AbortController()
  active.set(conv.id, ctl)

  const finish = async (e: Extract<ChatEvent, { type: 'done' | 'error' }>) => {
    active.delete(conv.id)
    await saveConversation(conv)
    emit(wc, e)
  }

  if (!provider) return finish({ type: 'error', conversationId: conv.id, messageId: assistant.id, error: 'No provider configured. Open Settings to add one.' })
  if (!useModel) {
    assistant.error = 'No model selected.'
    return finish({ type: 'error', conversationId: conv.id, messageId: assistant.id, error: 'No model selected. Pick one in the model menu or set a default in Settings.' })
  }

  const system = conv.systemPrompt ?? settings.systemPrompt
  const wire: WireMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...conv.messages
      .filter((m) => m.id !== assistant.id && !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }))
  ]

  let lastSave = Date.now()
  try {
    for await (const text of streamChat({
      baseUrl: provider.baseUrl,
      apiKey: decryptKey(provider),
      model: useModel,
      messages: wire,
      temperature: settings.temperature,
      signal: ctl.signal
    })) {
      assistant.content += text
      emit(wc, { type: 'delta', conversationId: conv.id, messageId: assistant.id, text })
      if (Date.now() - lastSave > SAVE_EVERY_MS) {
        lastSave = Date.now()
        void saveConversation(conv)
      }
    }
    await finish({ type: 'done', conversationId: conv.id, messageId: assistant.id })
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError' || ctl.signal.aborted) {
      // User pressed Stop: keep whatever streamed so far, no error state.
      await finish({ type: 'done', conversationId: conv.id, messageId: assistant.id })
    } else {
      assistant.error = err.message
      await finish({ type: 'error', conversationId: conv.id, messageId: assistant.id, error: err.message })
    }
  }
}

export async function sendMessage(
  wc: WebContents,
  req: { conversationId: string; content: string; providerId?: string; model?: string }
): Promise<Conversation> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('A response is already being generated')
  const content = req.content.trim()
  if (!content) throw new Error('Empty message')

  if (conv.messages.length === 0) conv.title = titleFrom(content)
  conv.messages.push({ id: randomUUID(), role: 'user', content, createdAt: Date.now() })
  await saveConversation(conv)

  void generate(wc, conv, req.providerId, req.model) // streams via events
  return conv
}

export async function regenerate(
  wc: WebContents,
  req: { conversationId: string; providerId?: string; model?: string }
): Promise<Conversation> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('A response is already being generated')
  // Drop trailing assistant message(s) so the last user turn is re-answered.
  while (conv.messages.at(-1)?.role === 'assistant') conv.messages.pop()
  if (conv.messages.at(-1)?.role !== 'user') throw new Error('Nothing to regenerate')
  await saveConversation(conv)
  void generate(wc, conv, req.providerId, req.model)
  return conv
}

export function stop(conversationId: string): void {
  active.get(conversationId)?.abort()
}
