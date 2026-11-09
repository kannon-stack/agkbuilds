import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { APP_NAME } from '../../../shared/types'
import { MOD } from '../platform'
import { ModelPicker } from './ModelPicker'
import { ExportMenu } from './ExportMenu'
import { Icon, Mark } from './Icons'

/** Chat title: double-click (or ⋯ → Rename…) to edit. */
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

/**
 * The app-drawn window title bar. Empty space drags the window; the OS draws its own window
 * buttons on top (traffic lights on the left on macOS, minimise/maximise/close on the right elsewhere).
 */
export function TitleBar() {
  const { active, settingsOpen, sidebarCollapsed, toggleSidebar } = useStore()
  const [renaming, setRenaming] = useState(false)
  const empty = !active || active.messages.length === 0
  useEffect(() => setRenaming(false), [active?.id])

  return (
    <header className="titlebar">
      <div className="tb-lead">
        <button
          className="tb-btn"
          onClick={() => toggleSidebar()}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          aria-pressed={!sidebarCollapsed}
          title={`${sidebarCollapsed ? 'Show' : 'Hide'} sidebar (${MOD} B)`}
          disabled={settingsOpen}
        >
          <Icon name="panel" />
        </button>
        <span className="tb-brand">
          <Mark /> {APP_NAME}
        </span>
      </div>
      <div className="tb-main">
        {settingsOpen ? (
          <span className="tb-title chat-head">
            <h1>Settings</h1>
          </span>
        ) : (
          <>
            <ModelPicker />
            <span className="tb-title chat-head">
              {empty ? <h1 className="muted">New chat</h1> : <EditableTitle key={active!.id} id={active!.id} title={active!.title} editing={renaming} onEditing={setRenaming} />}
            </span>
            {!empty && <ExportMenu conversationId={active!.id} onRename={() => setRenaming(true)} />}
          </>
        )}
      </div>
    </header>
  )
}
