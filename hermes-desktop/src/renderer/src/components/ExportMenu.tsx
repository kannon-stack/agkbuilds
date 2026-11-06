import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/** Header "⋯" menu: copy the visible branch as Markdown, or save it as .md / .json. */
export function ExportMenu({ conversationId }: { conversationId: string }) {
  const showToast = useStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const run = async (how: 'markdown' | 'json' | 'copy') => {
    setOpen(false)
    const r = await window.api.conversations.export(conversationId, how)
    if (!r.ok) showToast(r.error)
    else if (how === 'copy') showToast('Copied conversation as Markdown')
    else if (r.value.path) showToast(`Saved to ${r.value.path}`)
  }

  return (
    <div className="export-menu" ref={box}>
      <button className="icon-btn" aria-label="Export conversation" aria-haspopup="menu" aria-expanded={open} title="Export" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => run('copy')}>Copy as Markdown</button>
          <button role="menuitem" onClick={() => run('markdown')}>Save as Markdown…</button>
          <button role="menuitem" onClick={() => run('json')}>Save as JSON (all branches)…</button>
        </div>
      )}
    </div>
  )
}
