import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { MAX_TOOL_STEPS, metaFor } from '../shared/toolMeta'
import type { ChatEvent, Compaction, Conversation, EditRequest, ProviderRecord, Result, SendRequest, Settings, Message, ToolCall, ToolDecision } from '../shared/types'
import { streamChat, type ParsedToolCall, type StreamEvent, type WireContentPart, type WireMessage } from './openai'
import { missingImageNote, type ImageLookup } from '../shared/attachments'
import { claudeContextWindow, streamAnthropic, toAnthropicMessages, toAnthropicTools } from './anthropic'
import { DEFAULT_ANTHROPIC_OPTIONS, refusalMessage } from '../shared/anthropic'
import { activeTools, authorize, getTool, systemNote, toToolDefs, ToolError } from './tools'
import { skillPayload } from './tools/skillTools'
import { activeSkills } from './skills/registry'
import { services } from './services'
import { formatMemoryBlock } from '../shared/memory'
import { formatSkillCatalog, parseSlash, skillInvocation } from '../shared/skills'
import { mcp } from './mcp/instance'
import { decryptKey, getConversation, getProviderRecord, getSettings, saveConversation } from './store'
import { pathOf, pathTo, setLeaf, switchTo } from '../shared/tree'
import {
  autoCompactAt, chooseBoundary, contextUsage, estimateMessages, estimateText, fitToWindow, inputBudget, KEEP_TURNS_AUTO, KEEP_TURNS_MANUAL,
  liveRegion, MIN_WINDOW, parseOverflow, summaryBlock, windowFor, type ContextUsage, type WindowInfo
} from '../shared/context'
import { completeText, summarize } from './summarize'
import { sanitizeTitle, titleBasis, titleRequest, TITLE_SYSTEM, wantsAutoTitle } from '../shared/titles'
import { addUserMessage, editUserMessage, OpError, prepareRegenerate } from './conversationOps'

/** Active generations, keyed by conversation id. One at a time per conversation. */
const active = new Map<string, AbortController>()
/** Tool approvals waiting on the user, keyed by tool-call id. */
const pendingApprovals = new Map<string, (d: ToolDecision) => void>()
/** Tools the user approved "for this chat" (kept in memory only; resets on restart). */
const chatAllowed = new Map<string, Set<string>>()

const emit = (wc: WebContents, e: ChatEvent) => {
  if (!wc.isDestroyed()) wc.send('chat:event', e)
}

/** Persist the partial assistant text at most this often while streaming. */
const SAVE_EVERY_MS = 1500

/** Turn stored messages into the provider's wire format (assistant tool_calls + tool results). */
export function toWire(messages: Message[], images: ImageLookup = new Map()): WireMessage[] {
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
    } else if (m.role === 'user' && m.attachments?.length) {
      // Images first, then the text. A file that has gone missing is mentioned rather than silently dropped.
      const parts: WireContentPart[] = []
      const notes: string[] = []
      for (const a of m.attachments) {
        const b64 = images.get(a.id)
        if (b64) parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${b64}` } })
        else notes.push(missingImageNote(a.name))
      }
      const body = m.skill ? skillInvocation(m.skill.name, m.skill.text, parseSlash(m.content)?.args ?? '') : m.content
      const text = [body, ...notes].filter(Boolean).join('\n')
      if (text) parts.push({ type: 'text', text })
      if (parts.length) out.push({ role: 'user', content: parts })
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

/** Base64 data for every image on the path (so each request can include them; files that vanished are simply absent). */
async function loadImages(history: Message[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const m of history) {
    for (const a of m.attachments ?? []) {
      if (out.has(a.id)) continue
      const buf = await services.attachments.read(a)
      if (buf) out.set(a.id, buf.toString('base64'))
    }
  }
  return out
}

/** Conversations being generated right now (their in-memory copy is the one that gets saved, so edits made meanwhile must go through it). */
const liveConvs = new Map<string, Conversation>()

/** Change a conversation without losing the update to a running generation's later saves. Returns null if it no longer exists. */
async function mutateConversation(id: string, fn: (c: Conversation) => void): Promise<Conversation | null> {
  const conv = liveConvs.get(id) ?? (await getConversation(id))
  if (!conv) return null
  fn(conv)
  await saveConversation(conv, { touch: false })
  return conv
}

/** Set a title by hand; it is never changed automatically afterwards. */
export async function renameChat(id: string, title: string): Promise<void> {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!t) return
  await mutateConversation(id, (c) => {
    c.title = t
    c.titleSource = 'manual'
  })
}

/**
 * Ask the model for a short title from the first exchange. `force` (the "Regenerate title" action) also replaces a typed title.
 * Returns the new title, or null when skipped / the model gave nothing usable. Throws on provider errors.
 */
export async function generateTitle(wc: WebContents, id: string, force = false): Promise<string | null> {
  const settings = await getSettings()
  if (!force && !settings.titles.enabled) return null
  const conv = liveConvs.get(id) ?? (await getConversation(id))
  if (!conv || (!force && !wantsAutoTitle(conv))) return null
  const basis = titleBasis(conv)
  if (!basis) return null
  const provider = await getProviderRecord(conv.providerId ?? settings.activeProviderId)
  const model = settings.titles.model || conv.model || provider?.defaultModel || ''
  if (!provider || !model) return null

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 25_000)
  let raw: string
  try {
    raw = await completeText(
      { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: decryptKey(provider), model, anthropicOptions: provider.options, signal: ctl.signal },
      TITLE_SYSTEM,
      titleRequest(basis.user, basis.assistant),
      300
    )
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
  const title = sanitizeTitle(raw)
  if (!title) return null
  let applied = false
  await mutateConversation(id, (c) => {
    // The user may have typed a title while we were waiting; theirs wins (unless this was an explicit regenerate).
    if (!force && (c.titleSource === 'manual' || c.titleSource === 'generated')) return
    c.title = title
    c.titleSource = 'generated'
    applied = true
  })
  if (!applied) return null
  emit(wc, { type: 'title', conversationId: id, title })
  return title
}

/** Context windows learned from "maximum context length is N" errors (in memory), per provider+model. */
const learnedWindows = new Map<string, number>()
/** What a provider told us about a model's window (negative results are cached briefly so an offline provider isn't re-asked on every refresh). */
const providerWindows = new Map<string, { tokens?: number; at: number }>()
const FAIL_TTL_MS = 5 * 60_000

async function resolveWindow(provider: ProviderRecord | undefined, model: string, settings: Settings): Promise<WindowInfo> {
  const key = `${provider?.id}|${model}`
  let reported: number | undefined
  if (provider?.kind === 'anthropic' && model) {
    const hit = providerWindows.get(key)
    if (hit && (hit.tokens || Date.now() - hit.at < FAIL_TTL_MS)) reported = hit.tokens
    else {
      reported = await claudeContextWindow(provider.baseUrl, decryptKey(provider), model).catch(() => undefined)
      providerWindows.set(key, { tokens: reported, at: Date.now() })
    }
  }
  return windowFor(model, { setting: settings.context.window, learned: learnedWindows.get(key), provider: reported })
}

/** System prompt + tool definitions for a request (shared by generation and the context meter). */
async function buildPrompt(settings: Settings, conv: Conversation) {
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
  return { extra, ws, tools, toolDefs, system }
}

interface CompactOptions {
  provider: ProviderRecord
  model: string
  settings: Settings
  window: WindowInfo
  auto: boolean
  keep: number
  instructions?: string
  signal: AbortSignal
}

/**
 * Summarize the older part of `path` and store the summary on the boundary message. Returns null when there's
 * nothing worth summarizing. Throws on provider errors / abort (the caller decides how to degrade).
 */
async function compactPath(wc: WebContents, conv: Conversation, path: Message[], o: CompactOptions): Promise<Compaction | null> {
  const b = chooseBoundary(path, o.keep)
  if (!b) return null
  emit(wc, { type: 'compacting', conversationId: conv.id })
  const live = liveRegion(path)
  const tokensBefore = estimateMessages(live.messages) + (live.compaction ? estimateText(live.compaction.text) : 0)
  const text = await summarize({
    kind: o.provider.kind,
    baseUrl: o.provider.baseUrl,
    apiKey: decryptKey(o.provider),
    model: o.model,
    anthropicOptions: o.provider.options,
    messages: b.messages,
    previous: b.previous?.text,
    instructions: o.instructions,
    window: o.window.tokens,
    signal: o.signal
  })
  const keptFrom = path.indexOf(b.node) + 1
  const compaction: Compaction = {
    text,
    createdAt: Date.now(),
    auto: o.auto,
    messages: (b.previous?.messages ?? 0) + b.messages.length,
    tokensBefore,
    tokensAfter: estimateText(text) + estimateMessages(path.slice(keptFrom))
  }
  b.node.compaction = compaction
  await saveConversation(conv)
  emit(wc, { type: 'compacted', conversationId: conv.id, messageId: b.node.id, compaction })
  return compaction
}

/** "/compact": summarize older messages now. */
export async function compactChat(wc: WebContents, conversationId: string, instructions?: string): Promise<Result<{ messageId: string; compaction: Compaction }>> {
  const conv = await getConversation(conversationId)
  if (!conv) return { ok: false, error: 'Conversation not found' }
  if (active.has(conv.id)) return { ok: false, error: 'Wait for the current response to finish first.' }
  const settings = await getSettings()
  const provider = await getProviderRecord(conv.providerId ?? settings.activeProviderId)
  const model = conv.model || provider?.defaultModel || ''
  if (!provider || !model) return { ok: false, error: 'Choose a provider and model first.' }
  const ctl = new AbortController()
  active.set(conv.id, ctl)
  liveConvs.set(conv.id, conv)
  try {
    const compaction = await compactPath(wc, conv, pathOf(conv), {
      provider, model, settings, window: await resolveWindow(provider, model, settings), auto: false, keep: KEEP_TURNS_MANUAL,
      instructions: instructions?.trim() || undefined, signal: ctl.signal
    })
    if (!compaction) return { ok: false, error: 'Nothing to compact yet — the conversation is still short.' }
    return { ok: true, value: { messageId: conv.messages.find((m) => m.compaction === compaction)!.id, compaction } }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.name === 'AbortError' || ctl.signal.aborted ? 'Cancelled.' : `Couldn’t summarize: ${err.message}` }
  } finally {
    active.delete(conv.id)
    liveConvs.delete(conv.id)
  }
}

/** Data for the context meter. */
export async function contextFor(conversationId: string): Promise<ContextUsage | null> {
  const conv = await getConversation(conversationId)
  if (!conv) return null
  const settings = await getSettings()
  const provider = await getProviderRecord(conv.providerId ?? settings.activeProviderId)
  const model = conv.model || provider?.defaultModel || ''
  const prompt = await buildPrompt(settings, conv)
  return contextUsage(pathOf(conv), {
    systemTokens: estimateText(prompt.system),
    toolTokens: estimateText(JSON.stringify(prompt.toolDefs)),
    window: await resolveWindow(provider, model, settings),
    settings: settings.context
  })
}

/** Stream an answer as a new child of `parentId` (the user message being answered). */
async function generate(wc: WebContents, conv: Conversation, parentId: string, providerId?: string, model?: string) {
  const settings = await getSettings()
  const provider = await getProviderRecord(providerId ?? conv.providerId ?? settings.activeProviderId)
  const useModel = model ?? conv.model ?? provider?.defaultModel ?? ''
  conv.providerId = provider?.id
  conv.model = useModel

  const ctl = new AbortController()
  active.set(conv.id, ctl)
  liveConvs.set(conv.id, conv)
  const allowed = chatAllowed.get(conv.id) ?? chatAllowed.set(conv.id, new Set()).get(conv.id)!

  const newAssistant = async (parent: string): Promise<Message> => {
    const m: Message = { id: randomUUID(), role: 'assistant', content: '', createdAt: Date.now(), model: useModel, parentId: parent }
    conv.messages.push(m)
    setLeaf(conv, m.id)
    await saveConversation(conv)
    emit(wc, { type: 'start', conversationId: conv.id, messageId: m.id, parentId: parent })
    return m
  }
  const updateCall = (m: Message, call: ToolCall) => {
    emit(wc, { type: 'tool_update', conversationId: conv.id, messageId: m.id, call: { ...call } })
  }

  let last = await newAssistant(parentId)
  const end = async (kind: 'done' | 'error', error?: string) => {
    active.delete(conv.id)
    if (kind === 'error') last.error = error
    await saveConversation(conv)
    liveConvs.delete(conv.id)
    emit(wc, kind === 'error'
      ? { type: 'error', conversationId: conv.id, messageId: last.id, error: error! }
      : { type: 'done', conversationId: conv.id, messageId: last.id })
    // A title is a nicety: write it in the background, never delay or fail the turn.
    if (kind === 'done' && last.content.trim()) void generateTitle(wc, conv.id).catch(() => {})
  }

  if (!provider) return end('error', 'No provider configured. Open Settings to add one.')
  if (!useModel) return end('error', 'No model selected. Pick one in the model menu or set a default in Settings.')

  // Give servers still starting up (e.g. right after launch) a moment so the first message can use them.
  await mcp.settled(4000)
  const { extra, ws, tools, toolDefs, system } = await buildPrompt(settings, conv)
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

  let win = await resolveWindow(provider, useModel, settings)
  let windowCap = Infinity // tightened after a "too long" error that doesn't say the limit
  const overhead = estimateText(system) + estimateText(JSON.stringify(toolDefs))
  let step = 0
  let reuse = false
  let recovered = false
  let noticed = false
  let lastEstimate = 0
  const compactOpts = (auto: boolean, keep: number): CompactOptions => ({ provider, model: useModel, settings, window: win, auto, keep, signal: ctl.signal })

  for (;;) {
  try {
    for (; step < MAX_TOOL_STEPS; step++) {
      if (step > 0 && !reuse) last = await newAssistant(last.id)
      reuse = false
      const assistant = last

      // History = everything before this (still empty) assistant message, minus what's been summarized or doesn't fit.
      const path = pathTo(conv, assistant.parentId)
      const tokens = Math.min(win.tokens, windowCap)
      const live = liveRegion(path)
      const liveEstimate = overhead + (live.compaction ? estimateText(live.compaction.text) : 0) + estimateMessages(live.messages)
      if (settings.context.auto && liveEstimate > autoCompactAt(tokens, settings.context)) {
        try {
          await compactPath(wc, conv, path, compactOpts(true, KEEP_TURNS_AUTO))
        } catch (e) {
          if ((e as Error).name === 'AbortError' || ctl.signal.aborted) throw e
          emit(wc, { type: 'notice', conversationId: conv.id, text: `Couldn’t summarize earlier messages (${(e as Error).message}); trimming instead.` })
        }
      }
      const fit = fitToWindow(path, { budget: inputBudget(tokens), overhead })
      lastEstimate = fit.estimate
      if ((fit.trimmed || fit.dropped) && !noticed) {
        noticed = true
        emit(wc, {
          type: 'notice',
          conversationId: conv.id,
          text: fit.dropped
            ? `Left out the ${fit.dropped} earliest messages to fit the model’s context window. Use /compact to keep their gist.`
            : 'Shortened older tool results and images to fit the model’s context window.'
        })
      }
      const history = fit.messages
      const sys = [system, fit.summary ? summaryBlock(fit.summary) : '', fit.dropped ? `[${fit.dropped} earlier messages were left out to fit the context window.]` : ''].filter(Boolean).join('\n\n')
      const images = await loadImages(history)
      const wire: WireMessage[] = [...(sys ? [{ role: 'system' as const, content: sys }] : []), ...toWire(history, images)]

      let calls: ParsedToolCall[] = []
      let refusal: string | undefined
      let lastSave = Date.now()
      const events: AsyncGenerator<StreamEvent> =
        provider.kind === 'anthropic'
          ? streamAnthropic({
              baseUrl: provider.baseUrl,
              apiKey: decryptKey(provider),
              model: useModel,
              system: sys,
              messages: toAnthropicMessages(history, images),
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
    // "Prompt too long": shrink the history once and retry this step instead of failing the turn.
    const ov = parseOverflow(err.message)
    if (ov.overflow && !recovered && !ctl.signal.aborted && !last.content && !last.toolCalls?.length) {
      recovered = true
      if (ov.limit) {
        learnedWindows.set(`${provider.id}|${useModel}`, ov.limit)
        win = windowFor(useModel, { setting: settings.context.window, learned: ov.limit })
      } else {
        windowCap = Math.max(MIN_WINDOW, Math.floor(lastEstimate * 0.7))
      }
      try {
        if (settings.context.auto) await compactPath(wc, conv, pathTo(conv, last.parentId), compactOpts(true, KEEP_TURNS_MANUAL))
      } catch {
        /* fall through: trimming still shrinks the next attempt */
      }
      reuse = true
      continue
    }
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
    return await end('error', ov.overflow ? `${err.message}\n\nThe conversation is too long for this model’s context window. Use /compact, start a new chat, or set the window size in Settings → General.` : err.message)
  }
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
  req: SendRequest
): Promise<Conversation> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('A response is already being generated')
  const content = req.content.trim()
  const attachments = await services.attachments.verifyAll(req.attachments)
  if (!content && !attachments.length) throw new Error('Empty message')

  const skill = content ? await resolveSkill(content) : undefined
  const user = addUserMessage(conv, { content, attachments, ...(skill ? { skill } : {}) })
  await saveConversation(conv)

  void generate(wc, conv, user.id, req.providerId, req.model) // streams via events
  return conv
}

/** Resolve a "/skill" prefix into a snapshot of the skill's instructions (works even with tools off). */
async function resolveSkill(content: string): Promise<Message['skill']> {
  const slash = parseSlash(content)
  if (!slash) return undefined
  const settings = await getSettings()
  if (!settings.skills.enabled) return undefined
  const rec = activeSkills(await services.skills.scan(settings.tools.workspace), settings.skills).find((r) => r.name === slash.command)
  return rec ? { name: rec.name, text: skillPayload(rec) } : undefined
}

export async function editMessage(
  wc: WebContents,
  req: EditRequest
): Promise<Conversation> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('A response is already being generated')
  const content = req.content.trim()
  const orig = conv.messages.find((m) => m.id === req.messageId)
  const attachments = req.attachments === undefined ? undefined : await services.attachments.verifyAll(req.attachments)
  if (!content && !(attachments ?? orig?.attachments)?.length) throw new Error('Empty message')
  const user = editUserMessage(conv, req.messageId, { content, attachments, skill: await resolveSkill(content) })
  await saveConversation(conv)
  void generate(wc, conv, user.id, req.providerId, req.model)
  return conv
}

export async function regenerate(
  wc: WebContents,
  req: { conversationId: string; providerId?: string; model?: string }
): Promise<Conversation> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('A response is already being generated')
  const user = prepareRegenerate(conv)
  await saveConversation(conv)
  void generate(wc, conv, user.id, req.providerId, req.model)
  return conv
}

/** Jump to a message from search: switch branches only if it isn't already on screen. Doesn't count as activity. */
export async function reveal(conversationId: string, messageId: string): Promise<Conversation> {
  const conv = await getConversation(conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (!conv.messages.some((m) => m.id === messageId)) return conv
  if (pathOf(conv).some((m) => m.id === messageId) || active.has(conv.id)) return conv
  switchTo(conv, messageId)
  await saveConversation(conv, { touch: false })
  return conv
}

/** Show another branch (the one through `messageId`). */
export async function switchBranch(conversationId: string, messageId: string): Promise<Conversation> {
  const conv = await getConversation(conversationId)
  if (!conv) throw new Error('Conversation not found')
  if (active.has(conv.id)) throw new Error('Wait for the response to finish first')
  if (!conv.messages.some((m) => m.id === messageId)) throw new OpError('Message not found')
  switchTo(conv, messageId)
  await saveConversation(conv, { touch: false })
  return conv
}

export function stop(conversationId: string): void {
  active.get(conversationId)?.abort()
}
