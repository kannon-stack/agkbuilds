import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveModel, useStore } from '../store'
import { APP_NAME } from '../../../shared/types'
import { pathOf, siblingInfo } from '../../../shared/tree'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'
import { ExportMenu } from './ExportMenu'
import { CompactionDivider } from './CompactionDivider'

/** Chat title in the header: double-click (or ⋯ → Rename…) to edit. */
function EditableTitle({ id, title, editing, onEditing }: { id: string; title: string; editing: boolean; onEditing(v: boolean): void }) {
  const rename = useStore((s) => s.rename)
  const [draft, setDraft] = useState(title)
  useEffect(() => {
    if (editing) setDraft(title)
  }, [editing])
  const commit = async () => {
    onEditing(false)
    const t = draft.trim()
    if (t && t !== title) await rename(id, t)
  }
  return editing ? (
    <input
      className="title-input"
      aria-label="Chat title"
      autoFocus
      value={draft}
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') onEditing(false)
      }}
    />
  ) : (
    <h1 title="Double-click to rename" onDoubleClick={() => onEditing(true)}>
      {title}
    </h1>
  )
}

export function ChatView() {
  const { active, generating, settings, send, stop, regenerate, edit, switchBranch, openSettings, compacting } = useStore()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [renaming, setRenaming] = useState(false)
  const [away, setAway] = useState(false) // scrolled up from the latest message
  // The messages on screen = the branch ending at the conversation's leaf.
  const path = useMemo(() => (active ? pathOf(active) : []), [active])
  const busy = !!active && !!generating[active.id]
  const { model, provider } = effectiveModel({ active, settings })

  // Keep pinned to the bottom while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [path, busy])
  useEffect(() => {
    stick.current = true
    setAway(false)
  }, [active?.id])

  // Arriving from a search result: scroll the message into view and flash it.
  const { focusId, clearFocus } = useStore()
  useEffect(() => {
    if (!focusId) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusId)}"]`)
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('flash')
    const t = setTimeout(() => {
      el.classList.remove('flash')
      clearFocus()
    }, 1800)
    return () => clearTimeout(t)
  }, [focusId, path, clearFocus])

  const empty = !active || active.messages.length === 0
  const lastId = path.at(-1)?.id

  return (
    <main className="chat">
      <header className="chat-head">
        {empty ? <h1>New chat</h1> : <EditableTitle key={active!.id} id={active!.id} title={active!.title} editing={renaming} onEditing={setRenaming} />}
        {!empty && <ExportMenu conversationId={active!.id} onRename={() => setRenaming(true)} />}
      </header>
      <div
        className="scroller"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          stick.current = near
          setAway((was) => (was === !near ? was : !near))
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
            {path.map((m, i) => (
              <Fragment key={m.id}>
              <MessageItem
                message={m}
                isLast={m.id === lastId}
                continuation={m.role === 'assistant' && path[i - 1]?.role === 'assistant'}
                streaming={busy && m.id === lastId && m.role === 'assistant'}
                busy={busy}
                compacting={!!compacting[active!.id]}
                siblings={siblingInfo(active!, m)}
                onRegenerate={regenerate}
                onEdit={edit}
                onSwitch={switchBranch}
              />
              {m.compaction && <CompactionDivider c={m.compaction} />}
              </Fragment>
            ))}
          </div>
        )}
      </div>
      <div className="to-latest-wrap">
      {away && !empty && (
        <button
          className="to-latest"
          aria-label="Scroll to latest message"
          title="Scroll to latest"
          onClick={() => {
            stick.current = true
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          ↓{busy ? ' New response' : ''}
        </button>
      )}
      </div>
      <Composer generating={busy} disabled={!active} onSend={send} onStop={stop} />
    </main>
  )
}
