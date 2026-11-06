import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { MOD } from '../platform'
import { APP_NAME, type ConversationSummary } from '../../../shared/types'

function bucket(ts: number): string {
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - day) return 'Yesterday'
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
  return 'Older'
}

export function Sidebar() {
  const { conversations, active, generating, newChat, select, remove, rename, openSettings } = useStore()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? conversations.filter((c) => c.title.toLowerCase().includes(needle) || c.preview.toLowerCase().includes(needle))
      : conversations
    const out: [string, ConversationSummary[]][] = []
    for (const c of list) {
      const b = bucket(c.updatedAt)
      const g = out.find(([name]) => name === b)
      if (g) g[1].push(c)
      else out.push([b, [c]])
    }
    return out
  }, [conversations, q])

  const commit = async () => {
    if (editing && draft.trim()) await rename(editing, draft.trim())
    setEditing(null)
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">✦</span> {APP_NAME}
      </div>
      <button className="btn new" onClick={newChat}>
        <span>＋ New chat</span>
        <kbd>{MOD} N</kbd>
      </button>
      <input className="search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      <nav className="convlist">
        {groups.map(([name, items]) => (
          <section key={name}>
            <h3>{name}</h3>
            {items.map((c) => (
              <div
                key={c.id}
                className={`conv ${active?.id === c.id ? 'active' : ''}`}
                onClick={() => select(c.id)}
                onDoubleClick={() => {
                  setEditing(c.id)
                  setDraft(c.title)
                }}
              >
                {editing === c.id ? (
                  <input
                    className="rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commit()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="conv-title">{c.title}</span>
                    {generating[c.id] && <span className="dot" title="Generating" />}
                    <button
                      className="conv-del"
                      title="Delete chat"
                      aria-label={`Delete ${c.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Delete “${c.title}”?`)) void remove(c.id)
                      }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        ))}
        {!groups.length && <p className="muted pad">{q ? 'No matches.' : 'No chats yet.'}</p>}
      </nav>
      <button className="btn ghost settings-btn" onClick={() => openSettings(true)}>
        ⚙ Settings <kbd>{MOD} ,</kbd>
      </button>
    </aside>
  )
}
