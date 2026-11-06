import { MAX_SUMMARY_CHARS, SUMMARY_SYSTEM, chunkTranscripts, summaryRequest } from '../shared/context'
import { DEFAULT_ANTHROPIC_OPTIONS } from '../shared/anthropic'
import type { AnthropicOptions } from '../shared/anthropic'
import type { Message } from '../shared/types'
import { streamAnthropic } from './anthropic'
import { streamChat } from './openai'

export interface SummarizeOptions {
  kind: 'openai' | 'anthropic'
  baseUrl: string
  apiKey?: string
  model: string
  anthropicOptions?: AnthropicOptions
  /** What to condense, oldest first. */
  messages: readonly Message[]
  /** Earlier summary to fold in. */
  previous?: string
  instructions?: string
  /** The model's context window — big histories are summarized in several passes that each fit. */
  window: number
  signal?: AbortSignal
}

async function once(o: SummarizeOptions, user: string): Promise<string> {
  let text = ''
  const events =
    o.kind === 'anthropic'
      ? streamAnthropic({
          baseUrl: o.baseUrl,
          apiKey: o.apiKey,
          model: o.model,
          system: SUMMARY_SYSTEM,
          messages: [{ role: 'user', content: user }],
          // Keep the summarizer simple and cheap: no reasoning output, no caching.
          options: { ...(o.anthropicOptions ?? DEFAULT_ANTHROPIC_OPTIONS), showThinking: false, promptCaching: false },
          signal: o.signal
        })
      : streamChat({
          baseUrl: o.baseUrl,
          apiKey: o.apiKey,
          model: o.model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: user }
          ],
          temperature: 0.2,
          signal: o.signal
        })
  for await (const ev of events) if (ev.type === 'text') text += ev.text
  return text.trim()
}

/** Ask the model for a summary of `messages` (folding in `previous`). Throws on provider errors or an empty reply. */
export async function summarize(o: SummarizeOptions): Promise<string> {
  const chunks = chunkTranscripts(o.messages, Math.max(1000, Math.floor(o.window * 0.5) - 1500))
  if (!chunks.length) throw new Error('Nothing to summarize.')
  let running = o.previous
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1
    running = await once(o, summaryRequest({ transcript: chunks[i], previous: running, instructions: last ? o.instructions : undefined }))
    if (!running) throw new Error('The model returned an empty summary.')
  }
  return running!.length > MAX_SUMMARY_CHARS ? `${running!.slice(0, MAX_SUMMARY_CHARS)}…` : running!
}
