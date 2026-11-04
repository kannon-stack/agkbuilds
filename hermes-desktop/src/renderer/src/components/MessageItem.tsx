import { useState } from 'react'
import type { Message } from '../../../shared/types'
import { Markdown } from './Markdown'

interface Props {
  message: Message
  streaming: boolean
  isLast: boolean
  onRegenerate(): void
}

export function MessageItem({ message, streaming, isLast, onRegenerate }: Props) {
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
        <div className="bubble">{message.content}</div>
      </div>
    )
  }

  return (
    <div className="msg msg-assistant">
      <div className="avatar" aria-hidden>
        ✦
      </div>
      <div className="msg-body">
        <div className="msg-meta">{message.model || 'Assistant'}</div>
        {message.content ? (
          <Markdown text={message.content} />
        ) : streaming ? (
          <div className="thinking">
            <span /> <span /> <span />
          </div>
        ) : null}
        {streaming && message.content && <span className="caret" />}
        {message.error && (
          <div className="msg-error" role="alert">
            <strong>Couldn’t finish this response.</strong> {message.error}
          </div>
        )}
        {!streaming && (
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
