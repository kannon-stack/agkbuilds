import { useEffect, useMemo, useRef, useState } from 'react'
import { effectiveModel, useStore } from '../store'

export function ModelPicker() {
  const { active, settings, models, modelsLoading, setModel, loadModels, openSettings } = useStore()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { provider, model } = effectiveModel({ active, settings })

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (models?.models ?? []).filter((m) => m.toLowerCase().includes(q))
  }, [models, query])

  if (!settings || !provider) return null
  const pick = (providerId: string, m: string) => {
    void setModel(providerId, m)
    setOpen(false)
    setQuery('')
  }
  const typed = query.trim()

  return (
    <div className="picker" ref={ref}>
      <button
        className="picker-btn"
        onClick={() => {
          setOpen(!open)
          if (!open) void loadModels(provider.id)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="picker-provider">{provider.name}</span>
        <span className="picker-sep">/</span>
        <span className="picker-model">{model || 'Select a model'}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="popover" role="listbox">
          <div className="popover-head">
            <select
              value={provider.id}
              onChange={(e) => {
                void useStore.getState().loadModels(e.target.value)
                void window.api.settings.update({ activeProviderId: e.target.value }).then((s) => useStore.getState().setSettings(s))
                if (active) void window.api.conversations.setModel(active.id, e.target.value, '')
                useStore.setState((st) => (st.active ? { active: { ...st.active, providerId: e.target.value, model: '' } } : st))
              }}
            >
              {settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="link-btn" onClick={() => loadModels(provider.id)} title="Refresh models">
              ↻
            </button>
          </div>
          <input
            autoFocus
            className="popover-search"
            placeholder="Search or type a model id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && typed && pick(provider.id, filtered[0] ?? typed)}
          />
          <div className="popover-list">
            {modelsLoading && <div className="muted pad">Loading models…</div>}
            {!modelsLoading && models && !models.ok && (
              <div className="pad">
                <div className="err-text">{models.error}</div>
                <button className="link-btn" onClick={() => { setOpen(false); openSettings(true) }}>
                  Check provider settings
                </button>
              </div>
            )}
            {filtered.map((m) => (
              <button key={m} className={`opt ${m === model ? 'sel' : ''}`} onClick={() => pick(provider.id, m)} role="option" aria-selected={m === model}>
                {m}
              </button>
            ))}
            {typed && !filtered.includes(typed) && (
              <button className="opt" onClick={() => pick(provider.id, typed)}>
                Use “{typed}”
              </button>
            )}
            {!modelsLoading && models?.ok && !filtered.length && !typed && <div className="muted pad">No models returned.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
