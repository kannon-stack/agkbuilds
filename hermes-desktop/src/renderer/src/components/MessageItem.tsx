import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../../shared/types'
import type { SiblingInfo } from '../../../shared/tree'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { Thumbs } from './Thumbs'

interface Props {
  message: Message
  streaming: boolean
  isLast: boolean
  /** Previous message was also the assistant (a tool round) — hide the avatar. */
  continuation: boolean
  /** A response is being generated: editing and branch switching are paused. */
  busy: boolean
  siblings: SiblingInfo
  onRegenerate(): void
  onEdit(messageId: string, text: string): void
  onSwitch(messageId: string): void
}

/** ‹ 2/3 › — flip between alternative edits / answers at this point of the conversation. */
function BranchNav({ info, id, disabled, onSwitch }: { info: SiblingInfo; id: string; disabled: boolean; onSwitch(id: string): void }) {
  if (info.count < 2) return null
  const go = (d: number) => onSwitch(info.ids[info.index - 1 + d])
  return (
    <span className="branch-nav" data-testid="branch-nav">
      <button className="link-btn" aria-label="Previous version" disabled={disabled || info.index <= 1} onClick={() => go(-1)}>
        ‹
      </button>
      <span aria-label={`Version ${info.index} of ${info.count}`}>
        {info.index}/{info.count}
      </span>
      <button className="link-btn" aria-label="Next version" disabled={disabled || info.index >= info.count} onClick={() => go(1)}>
        ›
      </button>
    </span>
  )
}

function Editor({ initial, allowEmpty, onSave, onCancel }: { initial: string; allowEmpty: boolean; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])
  const canSave = allowEmpty || !!text.trim()
  const save = () => canSave && onSave(text)
  return (
    <div className="editor">
      <textarea
        ref={ref}
        value={text}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="editor-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!canSave} onClick={save}>
          Save &amp; send
        </button>
      </div>
      <p className="muted editor-hint">Your original message and its replies are kept — switch back with ‹ ›. Attached images stay with the message.</p>
    </div>
  )
}

const n = (v?: number) => (v ?? 0).toLocaleString()
function Usage({ u }: { u: NonNullable<Message['usage']> }) {
  const cached = u.cacheRead ? ` · ${n(u.cacheRead)} cached` : ''
  return (
    <span className="usage" title={`Input ${n(u.input)} · output ${n(u.output)}${u.cacheRead ? ` · cache read ${n(u.cacheRead)}` : ''}${u.cacheWrite ? ` · cache write ${n(u.cacheWrite)}` : ''}`}>
      {n(u.input)} in · {n(u.output)} out{cached}
    </span>
  )
}

export function MessageItem({ message, streaming, isLast, continuation, busy, siblings, onRegenerate, onEdit, onSwitch }: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const isUser = message.role === 'user'
  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className={`bubble-col ${editing ? 'editing' : ''}`} data-message-id={message.id}>
          {message.skill && <span className="skill-chip" title="This message invoked a skill">⚡ {message.skill.name}</span>}
          {message.attachments && <Thumbs items={message.attachments} />}
          {editing ? (
            <Editor
              initial={message.content}
              allowEmpty={!!message.attachments?.length}
              onCancel={() => setEditing(false)}
              onSave={(t) => {
                setEditing(false)
                onEdit(message.id, t)
              }}
            />
          ) : (
            message.content && <div className="bubble">{message.content}</div>
          )}
          {!editing && (
            <div className={`msg-actions user-actions ${siblings.count > 1 ? 'pinned' : ''}`}>
              <BranchNav info={siblings} id={message.id} disabled={busy} onSwitch={onSwitch} />
              <button className="link-btn" disabled={busy} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="link-btn" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const calls = message.toolCalls ?? []
  const toolsActive = calls.some((c) => c.status === 'running' || c.status === 'awaiting_approval')

  return (
    <div className={`msg msg-assistant ${continuation ? 'cont' : ''}`} data-message-id={message.id}>
      <div className="avatar" aria-hidden style={continuation ? { visibility: 'hidden' } : undefined}>
        ✦
      </div>
      <div className="msg-body">
        {!continuation && <div className="msg-meta">{message.model || 'Assistant'}</div>}
        {message.thinking && (
          <details className="reasoning" open={streaming && !message.content}>
            <summary>{streaming && !message.content ? 'Thinking…' : 'Reasoning'}</summary>
            <div className="reasoning-body">{message.thinking}</div>
          </details>
        )}
        {message.content ? (
          <Markdown text={message.content} />
        ) : streaming && !calls.length && !message.thinking ? (
          <div className="thinking">
            <span /> <span /> <span />
          </div>
        ) : null}
        {streaming && message.content && !calls.length && <span className="caret" />}
        {calls.length > 0 && (
          <div className="tools">
            {calls.map((c) => (
              <ToolCallCard key={c.id} call={c} />
            ))}
          </div>
        )}
        {message.error && (
          <div className="msg-error" role="alert">
            <strong>Couldn’t finish this response.</strong> {message.error}
          </div>
        )}
        {!streaming && !toolsActive && (
          <div className={`msg-actions ${siblings.count > 1 ? 'pinned' : ''}`}>
            <BranchNav info={siblings} id={message.id} disabled={busy} onSwitch={onSwitch} />
            {message.content && (
              <button className="link-btn" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {message.usage && <Usage u={message.usage} />}
            {isLast && (
              <button className="link-btn" onClick={onRegenerate}>
                {message.error ? 'Retry' : 'Regenerate'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
