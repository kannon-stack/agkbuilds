import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { MAX_TOOL_STEPS, metaFor } from '../shared/toolMeta'
import type { ChatEvent, Conversation, Message, ToolCall, ToolDecision } from '../shared/types'
import { streamChat, type ParsedToolCall, type StreamEvent, type WireMessage } from './openai'
import { streamAnthropic, toAnthropicMessages, toAnthropicTools } from './anthropic'
import { DEFAULT_ANTHROPIC_OPTIONS, refusalMessage } from '../shared/anthropic'
import { activeTools, authorize, getTool, systemNote, toToolDefs, ToolError } from './tools'
import { skillPayload } from './tools/skillTools'
import { activeSkills } from './skills/registry'
import { services } from './services'
import { formatMemoryBlock } from '../shared/memory'
import { formatSkillCatalog, parseSlash, skillInvocation } from '../shared/skills'
import { mcp } from './mcp/instance'
import { decryptKey, getConversation, getProviderRecord, getSettings, saveConversation } from './store'

/** Active generations, keyed by conversation id. One at a time per conversation. */
const active = new Map<string, AbortController>()
/** Tool approvals waiting on the user, keyed by tool-call id. */
const pendingApprovals = new Map<string, (d: ToolDecision) => void>()
/** Tools the user approved "for this chat" (kept in memory only; resets on restart). */
const chatAllowed = new Map<string, Set<string>>()

const emit = (wc: WebContents, e: ChatEvent) => {
  if (!wc.isDestroyed()) wc.send('chat:event', e)
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || 'New chat'
}

/** Persist the partial assistant text at most this often while streaming. */
const SAVE_EVERY_MS = 1500

/** Turn stored messages into the provider's wire format (assistant tool_calls + tool results). */
export function toWire(messages: Message[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }))
      })
      for (const c of m.toolCalls) {
        out.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? 'Interrupted before completion.' })
      }
    } else if (m.content && !m.error) {
      // A /skill invocation carries its (snapshotted) instructions into the model's view of this turn.
      const content = m.role === 'user' && m.skill ? skillInvocation(m.skill.name, m.skill.text, parseSlash(m.content)?.args ?? '') : m.content
      out.push({ role: m.role, content })
    }
  }
  return out
}

function waitForApproval(callId: string, signal: AbortSignal): Promise<ToolDecision> {
  return new Promise((resolve) => {
    const done = (d: ToolDecision) => {
      pendingApprovals.delete(callId)
      signal.removeEventListener('abort', onAbort)
      resolve(d)
    }
    const onAbort = () => done('deny')
    pendingApprovals.set(callId, done)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function decide(callId: string, decision: ToolDecision): void {
  pendingApprovals.get(callId)?.(decision)
}

async function generate(wc: WebContents, conv: Conversation, providerId?: string, model?: string) {
  const settings = await getSettings()
  const provider = await getProviderRecord(providerId ?? conv.providerId ?? settings.activeProviderId)
  const useModel = model ?? conv.model ?? provider?.defaultModel ?? ''
  conv.providerId = provider?.id
  conv.model = useModel

  const ctl = new AbortController()
  active.set(conv.id, ctl)
  const allowed = chatAllowed.get(conv.id) ?? chatAllowed.set(conv.id, new Set()).get(conv.id)!

  const newAssistant = async (): Promise<Message> => {
    const m: Message = { id: randomUUID(), role: 'assistant', content: '', createdAt: Date.now(), model: useModel }
    conv.messages.push(m)
    await saveConversation(conv)
    emit(wc, { type: 'start', conversationId: conv.id, messageId: m.id })
    return m
  }
  const updateCall = (m: Message, call: ToolCall) => {
    emit(wc, { type: 'tool_update', conversationId: conv.id, messageId: m.id, call: { ...call } })
  }

  let last = await newAssistant()
  const end = async (kind: 'done' | 'error', error?: string) => {
    active.delete(conv.id)
    if (kind === 'error') last.error = error
    await saveConversation(conv)
    emit(wc, kind === 'error'
      ? { type: 'error', conversationId: conv.id, messageId: last.id, error: error! }
      : { type: 'done', conversationId: conv.id, messageId: last.id })
  }

  if (!provider) return end('error', 'No provider configured. Open Settings to add one.')
  if (!useModel) return end('error', 'No model selected. Pick one in the model menu or set a default in Settings.')

  // Give servers still starting up (e.g. right after launch) a moment so the first message can use them.
  await mcp.settled(4000)
  const extra = mcp.tools()
  const ws = settings.tools.workspace
  const usableSkills = settings.skills.enabled ? activeSkills(await services.skills.scan(ws), settings.skills) : []
  const tools = activeTools(settings.tools, extra, { memory: settings.memory.enabled, skills: settings.skills.enabled, haveSkills: usableSkills.length > 0 })
  const toolDefs = toToolDefs(tools)
  const memoryBlock = settings.memory.enabled
    ? formatMemoryBlock(await services.memory.list(), ws, { canWrite: tools.some((t) => t.name === 'remember') }).text
    : ''
  const skillCatalog = tools.some((t) => t.name === 'use_skill') ? formatSkillCatalog(usableSkills) : ''
  const system = [conv.systemPrompt ?? settings.systemPrompt, systemNote(tools, ws), memoryBlock, skillCatalog].filter(Boolean).join('\n\n')
  const toolCtx = {
    workspace: ws,
    signal: ctl.signal,
    services: {
      memory: services.memory,
      skills: services.skills,
      skillsConfig: () => settings.skills,
      changed: (kind: 'memory' | 'skills') => {
        if (!wc.isDestroyed()) wc.send('data:changed', kind)
      }
    }
  }

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      if (step > 0) last = await newAssistant()
      const assistant = last

      // History = everything before this (still empty) assistant message.
      const history = conv.messages.slice(0, conv.messages.indexOf(assistant))
      const wire: WireMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...toWire(history)]

      let calls: ParsedToolCall[] = []
      let refusal: string | undefined
      let lastSave = Date.now()
      const events: AsyncGenerator<StreamEvent> =
        provider.kind === 'anthropic'
          ? streamAnthropic({
              baseUrl: provider.baseUrl,
              apiKey: decryptKey(provider),
              model: useModel,
              system,
              messages: toAnthropicMessages(history),
              tools: toAnthropicTools(toolDefs),
              options: provider.options ?? DEFAULT_ANTHROPIC_OPTIONS,
              signal: ctl.signal
            })
          : streamChat({
              baseUrl: provider.baseUrl,
              apiKey: decryptKey(provider),
              model: useModel,
              messages: wire,
              temperature: settings.temperature,
              tools: toolDefs,
              signal: ctl.signal
            })
      for await (const ev of events) {
        if (ev.type === 'text') {
          assistant.content += ev.text
          emit(wc, { type: 'delta', conversationId: conv.id, messageId: assistant.id, text: ev.text })
          if (Date.now() - lastSave > SAVE_EVERY_MS) {
            lastSave = Date.now()
            void saveConversation(conv)
          }
        } else if (ev.type === 'thinking') {
          assistant.thinking = (assistant.thinking ?? '') + ev.text
          emit(wc, { type: 'thinking', conversationId: conv.id, messageId: assistant.id, text: ev.text })
        } else if (ev.type === 'meta') {
          // Stored verbatim so the next request can replay this turn exactly (Claude thinking signatures).
          if (ev.meta.raw) assistant.raw = ev.meta.raw
          assistant.usage = ev.meta.usage
          assistant.servedBy = ev.meta.servedBy
          if (ev.meta.refusal) refusal = refusalMessage(ev.meta.refusal)
          emit(wc, { type: 'meta', conversationId: conv.id, messageId: assistant.id, usage: ev.meta.usage, servedBy: ev.meta.servedBy })
        } else calls = ev.calls
      }
      if (refusal) return await end('error', refusal)
      if (!calls.length) return await end('done')

      // ---- run the requested tools ----
      assistant.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, status: 'running' as const }))
      await saveConversation(conv)
      for (const call of assistant.toolCalls) {
        if (ctl.signal.aborted) {
          call.status = 'denied'
          call.result = 'Cancelled by user.'
          updateCall(assistant, call)
          continue
        }
        await runToolCall(call, assistant)
        await saveConversation(conv)
      }
      if (ctl.signal.aborted) return await end('done')
    }
    return await end('error', `Stopped after ${MAX_TOOL_STEPS} tool steps. Send a message to let me continue.`)
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError' || ctl.signal.aborted) {
      // Stop pressed: keep what we have; any unfinished tool calls get a result so the history stays valid.
      for (const c of last.toolCalls ?? []) {
        if (c.result === undefined) {
          c.status = 'denied'
          c.result = 'Cancelled by user.'
        }
      }
      return await end('done')
    }
    return await end('error', err.message)
  }

  async function runToolCall(call: ToolCall, assistant: Message) {
    const tool = getTool(call.name, extra)
    let args: any
    const fail = (status: 'error' | 'denied', msg: string) => {
      call.status = status
      call.result = msg
      updateCall(assistant, call)
    }

    if (!tool) return fail('error', `Unknown tool "${call.name}".`)
    if (!tools.some((t) => t.name === tool.name)) return fail('denied', `The "${call.name}" tool is disabled.`)
    try {
      args = JSON.parse(call.arguments || '{}')
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object')
    } catch {
      return fail('error', 'Invalid arguments: expected a JSON object.')
    }
    call.summary = tool.describe(args)
    call.label = tool.label ?? metaFor(tool.name)?.label
    call.external = tool.external
    try {
      await tool.validate?.(args, toolCtx)
      call.detail = await tool.preview?.(args, toolCtx)
    } catch (e) {
      return fail('error', e instanceof ToolError ? e.message : (e as Error).message)
    }

    const verdict = await authorize(tool, args, settings.tools, toolCtx, allowed)
    if (verdict === 'deny') return fail('denied', 'Denied by settings.')
    if (verdict === 'ask') {
      call.status = 'awaiting_approval'
      updateCall(assistant, call)
      await saveConversation(conv)
      const decision = await waitForApproval(call.id, ctl.signal)
      if (decision === 'deny') return fail('denied', ctl.signal.aborted ? 'Cancelled by user.' : 'The user denied this tool call.')
      if (decision === 'allow_chat') {
        const outside = await tool.forceAsk?.(args, toolCtx).catch(() => true)
        allowed.add(outside ? `${tool.name}:outside` : tool.name)
      }
    }

    call.status = 'running'
    updateCall(assistant, call)
    try {
      call.result = await tool.run(args, toolCtx)
      call.status = 'done'
    } catch (e) {
      call.status = 'error'
      call.result = e instanceof ToolError ? e.message : `Tool crashed: ${(e as Error).message}`
    }
    updateCall(assistant, call)
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

  // "/skill-name …" invokes a skill directly (works even with tools off). Unknown commands are plain text.
  let skill: Message['skill']
  const slash = parseSlash(content)
  if (slash) {
    const settings = await getSettings()
    if (settings.skills.enabled) {
      const rec = activeSkills(await services.skills.scan(settings.tools.workspace), settings.skills).find((r) => r.name === slash.command)
      if (rec) skill = { name: rec.name, text: skillPayload(rec) }
    }
  }

  if (conv.messages.length === 0) conv.title = titleFrom(content)
  conv.messages.push({ id: randomUUID(), role: 'user', content, createdAt: Date.now(), ...(skill ? { skill } : {}) })
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
  // Drop everything after the last user turn (the assistant text and any tool rounds).
  while (conv.messages.at(-1)?.role === 'assistant') conv.messages.pop()
  if (conv.messages.at(-1)?.role !== 'user') throw new Error('Nothing to regenerate')
  await saveConversation(conv)
  void generate(wc, conv, req.providerId, req.model)
  return conv
}

export function stop(conversationId: string): void {
  active.get(conversationId)?.abort()
}
