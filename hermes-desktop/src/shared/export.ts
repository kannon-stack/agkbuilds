// Turn a conversation into a document. Pure (no I/O) so it's unit-testable and usable from main or renderer.
import { pathOf } from './tree'
import type { Conversation, Message, ToolCall } from './types'

export type ExportFormat = 'markdown' | 'json'

export interface MarkdownOptions {
  /** Include the model's reasoning text (off by default: it's long and rarely wanted). */
  reasoning?: boolean
  /** Tool results longer than this are cut. */
  maxResultChars?: number
}

const iso = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

/** A fence long enough that `text` can't close it early. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length))
  const bar = '`'.repeat(longest + 1)
  return `${bar}${lang}\n${text}\n${bar}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString()} more characters)` : text
}

function toolBlock(c: ToolCall, max: number): string {
  const head = `**Tool:** ${c.label ?? c.name}${c.summary ? ` — \`${c.summary.replace(/`/g, "'").replace(/\s+/g, ' ')}\`` : ''}${c.status === 'done' ? '' : ` _(${c.status})_`}`
  return c.result ? `${head}\n\n${fence(truncate(c.result, max))}` : head
}

function messageBlock(m: Message, opts: Required<MarkdownOptions>): string {
  const out: string[] = []
  if (m.role === 'user') {
    out.push(`## You`)
    if (m.skill) out.push(`_Skill: ${m.skill.name}_`)
    for (const a of m.attachments ?? []) out.push(`_[image: ${a.name}]_`)
    if (m.content) out.push(m.content)
  } else {
    out.push(`## ${m.model || 'Assistant'}`)
    if (opts.reasoning && m.thinking) out.push(`<details><summary>Reasoning</summary>\n\n${m.thinking}\n\n</details>`)
    if (m.content) out.push(m.content)
    for (const c of m.toolCalls ?? []) out.push(toolBlock(c, opts.maxResultChars))
    if (m.error) out.push(`> **Error:** ${m.error.replace(/\n/g, ' ')}`)
  }
  return out.join('\n\n')
}

/** Markdown for the branch currently on screen. */
export function toMarkdown(conv: Conversation, options: MarkdownOptions = {}): string {
  const opts = { reasoning: false, maxResultChars: 2000, ...options }
  const path = pathOf(conv)
  const meta = [`Exported ${iso(Date.now())}`, conv.model ? `Model: ${conv.model}` : '', `Started ${iso(conv.createdAt)}`].filter(Boolean).join(' · ')
  return [`# ${conv.title}`, `_${meta}_`, ...path.map((m) => messageBlock(m, opts))].join('\n\n') + '\n'
}

/** Everything (all branches), minus provider-internal replay blocks (`raw`), which are large and meaningless outside the app. */
export function toJson(conv: Conversation): string {
  const slim = { ...conv, messages: conv.messages.map(({ raw: _raw, ...m }) => m) }
  return JSON.stringify(slim, null, 2) + '\n'
}

/** A safe file name for the save dialog. */
export function exportFileName(conv: Conversation, format: ExportFormat): string {
  const slug =
    conv.title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 48) || 'chat'
  return `${slug}.${format === 'markdown' ? 'md' : 'json'}`
}
