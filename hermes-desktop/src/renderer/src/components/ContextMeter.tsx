import { useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '../../../shared/context'
import { effectiveModel, useStore } from '../store'
import { pathOf } from '../../../shared/tree'

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const SOURCE: Record<ContextUsage['windowSource'], string> = {
  setting: 'set in Settings',
  learned: 'learned from a provider error',
  provider: 'reported by the provider',
  model: 'guessed from the model name',
  default: 'default (unknown model)'
}

/** Composer chip showing how full the model's context window is; click for details and "Compact now". */
export function ContextMeter({ busy }: { busy: boolean }) {
  const { active, settings, compacting, compact, openSettings } = useStore()
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const { model } = effectiveModel({ active, settings })

  // Refresh whenever the visible conversation could have changed size (debounced).
  const leaf = active ? pathOf(active).at(-1) : undefined
  const key = [active?.id, leaf?.id, leaf?.usage?.input, leaf?.content.length === 0 ? 0 : 1, active?.messages.length, active?.messages.filter((m) => m.compaction).length, model, JSON.stringify(settings?.context), busy, compacting[active?.id ?? '']].join('|')
  useEffect(() => {
    if (!active) return
    let live = true
    const t = setTimeout(() => {
      void window.api.conversations.context(active.id).then((u) => live && setUsage(u))
    }, busy ? 800 : 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key])

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

  if (!active || !usage || (active.messages.length === 0 && usage.used < 200)) return null
  const pct = Math.min(1, usage.used / usage.window)
  const level = pct >= 0.95 ? 'danger' : usage.autoAt ? (usage.used >= usage.autoAt ? 'warn' : '') : pct >= 0.8 ? 'warn' : ''
  const isCompacting = !!compacting[active.id]

  return (
    <div className="ctx" ref={box}>
      <button className={`chip ctx-chip ${level}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Context ${Math.round(pct * 100)}% full`} title="Context window">
        <span className="ctx-ring" style={{ ['--p' as string]: `${pct * 360}deg` }} />
        {fmt(usage.used)} / {fmt(usage.window)}
      </button>
      {open && (
        <div className="ctx-pop" role="dialog" aria-label="Context details">
          <div className="ctx-bar"><span style={{ width: `${pct * 100}%` }} className={level} /></div>
          <p>
            <b>{usage.used.toLocaleString()}</b> of {usage.window.toLocaleString()} tokens ({Math.round(pct * 100)}%){' '}
            <span className="muted">{usage.source === 'reported' ? '· from the provider’s last count' : '· estimated'}</span>
          </p>
          <ul>
            <li><span>System prompt, memory &amp; tool definitions</span><span>{fmt(usage.parts.system + usage.parts.tools)}</span></li>
            {usage.parts.summary > 0 && <li><span>Summary of earlier messages</span><span>{fmt(usage.parts.summary)}</span></li>}
            <li><span>Messages</span><span>{fmt(usage.parts.messages)}</span></li>
          </ul>
          <p className="muted small">
            Window: {SOURCE[usage.windowSource]}.{' '}
            {usage.autoAt ? `Older messages are summarized automatically near ${fmt(usage.autoAt)}.` : 'Automatic summarizing is off.'}
            {usage.compactions > 0 && ` Summarized ${usage.compactions}×.`}
          </p>
          <div className="ctx-actions">
            <button className="btn" disabled={!usage.canCompact || busy || isCompacting} onClick={() => { setOpen(false); void compact() }}>
              {isCompacting ? 'Summarizing…' : 'Compact now'}
            </button>
            <button className="link-btn" onClick={() => { setOpen(false); openSettings(true, 'general') }}>Settings</button>
          </div>
        </div>
      )}
    </div>
  )
}
