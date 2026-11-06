import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS, formatMemoryBlock, type MemoryItem } from '../../../shared/memory'

const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString()
}
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function MemorySettings() {
  const { settings, memory, refreshMemory, patchSettings, showToast } = useStore()
  const [text, setText] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const workspace = settings?.tools.workspace ?? ''

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return memory.filter((m) => !needle || m.text.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [memory, q])
  const block = useMemo(() => formatMemoryBlock(memory, workspace, { canWrite: false }), [memory, workspace])

  if (!settings) return null
  const enabled = settings.memory.enabled

  const add = async () => {
    const r = await window.api.memory.add(text, scope)
    if (!r.ok) return setError(r.error)
    setText('')
    setError('')
    await refreshMemory()
  }
  const update = async (id: string, patch: { text?: string; enabled?: boolean }) => {
    const r = await window.api.memory.update(id, patch)
    if (!r.ok) showToast(r.error)
    await refreshMemory()
    return r.ok
  }
  const remove = async (m: MemoryItem) => {
    await window.api.memory.remove(m.id)
    await refreshMemory()
  }

  return (
    <div className="form">
      <label className="check switch">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void patchSettings({ memory: { enabled: e.target.checked } })}
        />
        <span>
          <b>Use memory</b>
          <span className="hint"> Saved notes are added to every chat so the model knows your preferences and projects. They’re stored on this computer in plain text (<code>memory.json</code>) — never put secrets in them.</span>
        </span>
      </label>

      <div className={`form-block ${enabled ? '' : 'dim'}`}>
        <b>Add a note</b>
        <div className="mem-add">
          <input
            value={text}
            maxLength={MEMORY_MAX_CHARS}
            placeholder="e.g. I prefer TypeScript and tabs"
            onChange={(e) => { setText(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && void add()}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'project')} aria-label="Scope">
            <option value="global">All chats</option>
            <option value="project" disabled={!workspace}>{workspace ? `Project: ${base(workspace)}` : 'This project (no folder set)'}</option>
          </select>
          <button className="btn primary" disabled={!text.trim()} onClick={add}>Add</button>
        </div>
        {error && <div className="status bad">{error}</div>}
        <span className="hint">
          You can also type <code>/remember …</code> in any chat. The model can save notes too — you’ll be asked to approve each one (change this in the Tools tab).
        </span>
      </div>

      <div className={`form-block ${enabled ? '' : 'dim'}`}>
        <div className="mem-head">
          <b>{memory.length} note{memory.length === 1 ? '' : 's'} <span className="muted small">/ {MEMORY_MAX_ITEMS}</span></b>
          <input className="mem-search" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
          {memory.length > 0 && (
            <button className="link-btn danger-link" onClick={async () => confirm(`Delete all ${memory.length} notes? This can’t be undone.`) && (await window.api.memory.clear(), await refreshMemory())}>
              Clear all
            </button>
          )}
        </div>
        {block.omitted > 0 && <div className="status bad">{block.omitted} older note{block.omitted === 1 ? '' : 's'} won’t fit in the prompt and are not sent to the model. Delete or merge some.</div>}
        {memory.length === 0 && <p className="muted">Nothing saved yet.</p>}
        <ul className="mem-list">
          {shown.map((m) => (
            <li key={m.id} className={m.enabled ? '' : 'off'}>
              <input type="checkbox" checked={m.enabled} onChange={(e) => update(m.id, { enabled: e.target.checked })} title="Include in chats" aria-label="Include in chats" />
              <div className="mem-body">
                {editing?.id === m.id ? (
                  <textarea
                    autoFocus
                    rows={2}
                    maxLength={MEMORY_MAX_CHARS}
                    value={editing.text}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onBlur={async () => { if (editing.text.trim() && editing.text !== m.text) await update(m.id, { text: editing.text }); setEditing(null) }}
                    onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && !e.shiftKey) (e.target as HTMLTextAreaElement).blur() }}
                  />
                ) : (
                  <div className="mem-text" onClick={() => setEditing({ id: m.id, text: m.text })} title="Click to edit">{m.text}</div>
                )}
                <div className="mem-meta">
                  <span className={`risk ${m.source === 'model' ? 'risk-network' : ''}`}>{m.source === 'model' ? 'saved by model' : 'you'}</span>
                  <span className="risk">{m.workspace ? `project: ${base(m.workspace)}` : 'all chats'}</span>
                  <span className="muted small">{ago(m.updatedAt)}</span>
                </div>
              </div>
              <button className="icon-btn" aria-label="Delete note" onClick={() => remove(m)}>✕</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
