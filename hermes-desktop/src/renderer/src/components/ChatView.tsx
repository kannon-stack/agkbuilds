import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveModel, useStore } from '../store'
import { APP_NAME } from '../../../shared/types'
import { pathOf, siblingInfo } from '../../../shared/tree'
import { greeting, STARTERS } from '../../../shared/greeting'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'
import { CompactionDivider } from './CompactionDivider'
import { Icon, Mark } from './Icons'

/** "Good evening, Dylan" — re-evaluated every few minutes so a window left open stays right. */
function useGreeting(name: string): string {
  const [hour, setHour] = useState(() => new Date().getHours())
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 5 * 60_000)
    return () => clearInterval(t)
  }, [])
  return greeting(hour, name)
}

export function ChatView() {
  const { active, generating, settings, send, stop, regenerate, edit, switchBranch, openSettings, compacting, prefill } = useStore()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const hello = useGreeting(settings?.userName ?? '')
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
    <main className={`chat ${empty ? 'is-empty' : ''}`}>
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
            <span className="welcome-mark"><Mark size={22} /></span>
            <h2>{hello}</h2>
            {(!provider?.baseUrl || !model) && (
              <div className="setup-card">
                <strong>Finish setup</strong>
                <p>Point {APP_NAME} at an OpenAI-compatible endpoint (like 9router) or Claude, and choose a model.</p>
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
          <Icon name="down" size={14} />{busy ? ' New response' : ''}
        </button>
      )}
      </div>
      <Composer generating={busy} disabled={!active} empty={empty} onSend={send} onStop={stop} />
      {empty && (
        <div className="starters" role="group" aria-label="Starter prompts">
          {STARTERS.map((s) => (
            <button key={s.label} className="starter" onClick={() => prefill(s.prompt)}>
              <Icon name={s.icon} size={15} /> {s.label}
            </button>
          ))}
        </div>
      )}
    </main>
  )
}
