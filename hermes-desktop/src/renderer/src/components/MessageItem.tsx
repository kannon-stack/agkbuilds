import { useState } from 'react'
import type { Message } from '../../../shared/types'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'

interface Props {
  message: Message
  streaming: boolean
  isLast: boolean
  /** Previous message was also the assistant (a tool round) — hide the avatar. */
  continuation: boolean
  onRegenerate(): void
}

export function MessageItem({ message, streaming, isLast, continuation, onRegenerate }: Props) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'
  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className="bubble-col">
          {message.skill && <span className="skill-chip" title="This message invoked a skill">⚡ {message.skill.name}</span>}
          <div className="bubble">{message.content}</div>
        </div>
      </div>
    )
  }

  const calls = message.toolCalls ?? []
  const toolsActive = calls.some((c) => c.status === 'running' || c.status === 'awaiting_approval')

  return (
    <div className={`msg msg-assistant ${continuation ? 'cont' : ''}`}>
      <div className="avatar" aria-hidden style={continuation ? { visibility: 'hidden' } : undefined}>
        ✦
      </div>
      <div className="msg-body">
        {!continuation && <div className="msg-meta">{message.model || 'Assistant'}</div>}
        {message.content ? (
          <Markdown text={message.content} />
        ) : streaming && !calls.length ? (
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
          <div className="msg-actions">
            {message.content && (
              <button className="link-btn" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
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
