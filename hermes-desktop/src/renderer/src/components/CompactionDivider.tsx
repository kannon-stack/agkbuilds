import { useState } from 'react'
import type { Compaction } from '../../../shared/types'

/** Marks where older messages were replaced by a summary (for the model — the full chat above stays visible). */
export function CompactionDivider({ c }: { c: Compaction }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="compaction" data-testid="compaction">
      <div className="compaction-line">
        <span>
          {c.auto ? 'Automatically summarized' : 'Summarized'} {c.messages} earlier message{c.messages === 1 ? '' : 's'} for the model · ~{c.tokensBefore.toLocaleString()} → {c.tokensAfter.toLocaleString()} tokens
        </span>
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide summary' : 'View summary'}
        </button>
      </div>
      {open && <pre className="compaction-text">{c.text}</pre>}
    </div>
  )
}
