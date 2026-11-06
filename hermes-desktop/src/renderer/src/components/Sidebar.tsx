import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { MOD } from '../platform'
import { APP_NAME, type ConversationSummary } from '../../../shared/types'
import type { SearchResult, SnippetPart } from '../../../shared/search'

function bucket(ts: number): string {
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - day) return 'Yesterday'
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
  return 'Older'
}

function Marked({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  )
}

export function Sidebar() {
  const { conversations, active, generating, newChat, select, remove, rename, reveal, openSettings } = useStore()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // Searching looks inside every message (all branches) in the main process; typing is debounced.
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const seq = useRef(0)
  const needle = q.trim()
  useEffect(() => {
    if (!needle) {
      seq.current++
      setResults(null)
      return
    }
    const mine = ++seq.current
    const t = setTimeout(async () => {
      try {
        const r = await window.api.conversations.search(needle)
        if (mine === seq.current) setResults(r)
      } catch {
        if (mine === seq.current) setResults([])
      }
    }, 120)
    return () => clearTimeout(t)
  }, [needle, conversations])

  const groups = useMemo(() => {
    const list = needle ? [] : conversations
    const out: [string, ConversationSummary[]][] = []
    for (const c of list) {
      const b = bucket(c.updatedAt)
      const g = out.find(([name]) => name === b)
      if (g) g[1].push(c)
      else out.push([b, [c]])
    }
    return out
  }, [conversations, needle])

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
      <input className="search" placeholder="Search all messages" aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      <nav className="convlist">
        {needle && (
          <div className="results" aria-label="Search results">
            {results?.map((r) => (
              <div key={r.conversationId} className="result">
                <button className="result-title" onClick={() => select(r.conversationId)}>
                  <Marked parts={r.titleParts} />
                </button>
                {r.hits.map((h) => (
                  <button key={h.messageId} className="snippet" onClick={() => reveal(r.conversationId, h.messageId)} title={h.onActivePath ? undefined : 'Opens another version of this chat'}>
                    <span className="snippet-role">{h.role === 'user' ? 'You' : 'AI'}</span>
                    <Marked parts={h.parts} />
                    {!h.onActivePath && <em className="snippet-branch">other version</em>}
                  </button>
                ))}
                {r.matchCount > r.hits.length && <span className="muted more">+{r.matchCount - r.hits.length} more</span>}
              </div>
            ))}
            {results && !results.length && <p className="muted pad">No matches.</p>}
          </div>
        )}
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
        {!needle && !groups.length && <p className="muted pad">No chats yet.</p>}
      </nav>
      <button className="btn ghost settings-btn" onClick={() => openSettings(true)}>
        ⚙ Settings <kbd>{MOD} ,</kbd>
      </button>
    </aside>
  )
}
