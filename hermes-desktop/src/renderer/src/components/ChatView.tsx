import { useEffect, useRef } from 'react'
import { effectiveModel, useStore } from '../store'
import { APP_NAME } from '../../../shared/types'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'

export function ChatView() {
  const { active, generating, settings, send, stop, regenerate, openSettings } = useStore()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const busy = !!active && !!generating[active.id]
  const { model, provider } = effectiveModel({ active, settings })

  // Keep pinned to the bottom while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [active?.messages, busy])
  useEffect(() => {
    stick.current = true
  }, [active?.id])

  const empty = !active || active.messages.length === 0
  const lastId = active?.messages.at(-1)?.id

  return (
    <main className="chat">
      <header className="chat-head">
        <h1>{empty ? 'New chat' : active!.title}</h1>
      </header>
      <div
        className="scroller"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {empty ? (
          <div className="welcome">
            <div className="welcome-mark">✦</div>
            <h2>{APP_NAME}</h2>
            <p className="muted">Your AI, on your terms. Start a conversation below.</p>
            {(!provider?.baseUrl || !model) && (
              <div className="setup-card">
                <strong>Finish setup</strong>
                <p>Point {APP_NAME} at an OpenAI-compatible endpoint (like 9router) and choose a model.</p>
                <button className="btn primary" onClick={() => openSettings(true)}>
                  Open settings
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="thread">
            {active!.messages.map((m, i) => (
              <MessageItem
                key={m.id}
                message={m}
                isLast={m.id === lastId}
                continuation={m.role === 'assistant' && active!.messages[i - 1]?.role === 'assistant'}
                streaming={busy && m.id === lastId && m.role === 'assistant'}
                onRegenerate={regenerate}
              />
            ))}
          </div>
        )}
      </div>
      <Composer generating={busy} disabled={!active} onSend={send} onStop={stop} />
    </main>
  )
}
