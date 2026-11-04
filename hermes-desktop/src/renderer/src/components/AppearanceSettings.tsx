import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { prefersDark } from '../applyTheme'
import type { ThemeSetting } from '../../../shared/types'
import {
  CHAT_WIDTH, COLOR_GROUPS, DEFAULT_APPEARANCE, FONT_SCALE_MAX, FONT_SCALE_MIN, MAX_CUSTOM_THEMES, RADIUS, UI_FONT_STACKS,
  allThemes, contrast, contrastChecks, exportTheme, normalizeHex, parseThemeFile, resolveAppearance,
  type Appearance, type ColorKey, type CustomTheme, type ThemeBase, type ThemeColors, type ThemeDef
} from '../../../shared/theme'

const ACCENTS = ['#e2b65c', '#ff9a62', '#f06b6b', '#ec7fb0', '#c58bff', '#8a95ff', '#5aa2ff', '#3ec6d8', '#4fd08f', '#a6d95b']
const newId = () => `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

interface EditorState {
  /** Existing custom theme being edited (undefined = new). */
  id?: string
  name: string
  base: ThemeBase
  colors: ThemeColors
}

export function AppearanceSettings() {
  const { settings, setSettings, updateAppearance, showToast } = useStore()
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [importing, setImporting] = useState(false)
  if (!settings) return null
  const a = settings.appearance
  const themes = allThemes(a)

  // Optimistic: the UI switches immediately; the saved result replaces it when it arrives.
  const setMode = async (theme: ThemeSetting) => {
    setSettings({ ...useStore.getState().settings!, theme })
    setSettings({ ...(await window.api.settings.update({ theme })), appearance: useStore.getState().settings!.appearance })
  }

  /** Choose a theme for its slot; switch mode if it wouldn't be visible otherwise. */
  const pick = async (t: ThemeDef) => {
    updateAppearance(t.base === 'dark' ? { darkTheme: t.id } : { lightTheme: t.id })
    const activeBase = settings.theme === 'system' ? (prefersDark() ? 'dark' : 'light') : settings.theme
    if (activeBase !== t.base) {
      await setMode(t.base)
      showToast(`Switched to ${t.base} mode to show ${t.name}`)
    }
  }

  if (editor) return <ThemeEditor key={editor.id ?? 'new'} initial={editor} onDone={() => setEditor(null)} />
  if (importing) return <ImportTheme onDone={() => setImporting(false)} onParsed={(e) => { setImporting(false); setEditor(e) }} />

  const edit = (t: ThemeDef) => setEditor({ id: t.id, name: t.name, base: t.base, colors: { ...t.colors } })
  const duplicate = (t: ThemeDef) => setEditor({ name: `${t.name} copy`, base: t.base, colors: { ...t.colors } })
  const remove = (t: ThemeDef) => {
    if (!confirm(`Delete the theme “${t.name}”?`)) return
    updateAppearance({ customThemes: a.customThemes.filter((c) => c.id !== t.id) })
  }
  const copy = async (t: ThemeDef) => {
    await navigator.clipboard.writeText(exportTheme(t))
    showToast(`Copied “${t.name}” as JSON`)
  }

  const resolved = resolveAppearance(settings.theme, a, prefersDark())
  const accentRatio = contrast(resolved.colors.accent, resolved.colors.bg)

  const group = (base: ThemeBase) => (
    <div className="form-block">
      <b>{base === 'dark' ? 'Dark themes' : 'Light themes'}</b>
      <div className="theme-grid">
        {themes.filter((t) => t.base === base).map((t) => {
          const selected = (base === 'dark' ? a.darkTheme : a.lightTheme) === t.id
          const custom = 'custom' in t
          return (
            <div key={t.id} className={`theme-item ${selected ? 'selected' : ''}`}>
              <button className="theme-card" onClick={() => pick(t)} aria-pressed={selected} aria-label={`${t.name}${selected ? ' (selected)' : ''}`} style={{ background: t.colors.bg, borderColor: selected ? t.colors.accent : t.colors.border }}>
                <span className="tc-side" style={{ background: t.colors.bgSidebar, borderColor: t.colors.border }}>
                  <i style={{ background: t.colors.surface2 }} /><i style={{ background: t.colors.surface2 }} />
                </span>
                <span className="tc-main">
                  <i className="tc-user" style={{ background: t.colors.surface2, borderColor: t.colors.border }} />
                  <i className="tc-line" style={{ background: t.colors.text }} />
                  <i className="tc-line short" style={{ background: t.colors.muted }} />
                  <i className="tc-code" style={{ background: t.colors.codeBg, borderColor: t.colors.border }}>
                    <b style={{ background: t.colors.hlKeyword }} /><b style={{ background: t.colors.hlString }} /><b style={{ background: t.colors.hlFn }} />
                  </i>
                  <i className="tc-btn" style={{ background: t.colors.accent }} />
                </span>
              </button>
              <div className="theme-meta">
                <span className="theme-name">{t.name}</span>
                <span className="theme-actions">
                  {custom ? <button className="link-btn" onClick={() => edit(t)}>Edit</button> : <button className="link-btn" onClick={() => duplicate(t)} title="Make an editable copy">Customize</button>}
                  {custom && <button className="link-btn" onClick={() => copy(t)}>Export</button>}
                  {custom && <button className="link-btn danger-link" onClick={() => remove(t)}>Delete</button>}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="form">
      <div className="form-block">
        <b>Mode</b>
        <div className="segmented" role="radiogroup" aria-label="Colour mode">
          {(['system', 'light', 'dark'] as ThemeSetting[]).map((m) => (
            <button key={m} role="radio" aria-checked={settings.theme === m} className={settings.theme === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <span className="hint">System follows your OS and uses your chosen light and dark themes below.</span>
      </div>

      {group('dark')}
      {group('light')}

      <div className="form-actions">
        <button className="btn" disabled={a.customThemes.length >= MAX_CUSTOM_THEMES} onClick={() => setEditor({ name: 'My theme', base: resolved.base, colors: { ...resolved.theme.colors } })}>＋ New theme</button>
        <button className="btn" onClick={() => setImporting(true)}>Import theme…</button>
      </div>

      <div className="form-block">
        <b>Accent colour</b>
        <div className="swatches">
          <button className={`swatch auto ${a.accent === null ? 'on' : ''}`} onClick={() => updateAppearance({ accent: null })} title="Use the theme's own accent" aria-label="Theme default accent" aria-pressed={a.accent === null}>
            <span style={{ background: allThemes(a).find((t) => t.id === (resolved.base === 'dark' ? a.darkTheme : a.lightTheme))?.colors.accent }} />
          </button>
          {ACCENTS.map((c) => (
            <button key={c} className={`swatch ${a.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => updateAppearance({ accent: c })} title={c} aria-label={`Accent ${c}`} aria-pressed={a.accent === c} />
          ))}
          <label className={`swatch picker ${a.accent && !ACCENTS.includes(a.accent) ? 'on' : ''}`} title="Pick any colour">
            <input type="color" value={a.accent ?? resolved.colors.accent} onChange={(e) => updateAppearance({ accent: e.target.value })} aria-label="Custom accent colour" />
            <span>＋</span>
          </label>
        </div>
        {a.accent && accentRatio < 3 && <span className="hint warn">This accent has low contrast on the current background ({accentRatio.toFixed(1)}:1). Buttons stay readable, but links and highlights may be hard to see.</span>}
      </div>

      <div className="form-block">
        <b>Typography</b>
        <div className="two-col">
          <label>
            Interface font
            <select value={a.uiFont} onChange={(e) => updateAppearance({ uiFont: e.target.value as Appearance['uiFont'] })}>
              {Object.entries(UI_FONT_STACKS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              <option value="custom">Custom…</option>
            </select>
            {a.uiFont === 'custom' && <FontInput value={a.uiFontCustom} onCommit={(v) => updateAppearance({ uiFontCustom: v })} placeholder="e.g. Inter, Helvetica Neue" />}
          </label>
          <label>
            Code font
            <select value={a.monoFont} onChange={(e) => updateAppearance({ monoFont: e.target.value as Appearance['monoFont'] })}>
              <option value="system">System monospace</option>
              <option value="custom">Custom…</option>
            </select>
            {a.monoFont === 'custom' && <FontInput value={a.monoFontCustom} onCommit={(v) => updateAppearance({ monoFontCustom: v })} placeholder="e.g. Fira Code" />}
          </label>
        </div>
        <label className="range-row">
          Text size <b>{Math.round(a.fontScale * 100)}%</b>
          <input type="range" min={FONT_SCALE_MIN} max={FONT_SCALE_MAX} step={0.05} value={a.fontScale} onChange={(e) => updateAppearance({ fontScale: +e.target.value })} aria-label="Text size" />
          {a.fontScale !== 1 && <button className="link-btn" onClick={() => updateAppearance({ fontScale: 1 })}>Reset</button>}
        </label>
        <span className="hint">Custom fonts must be installed on your computer; the app falls back to the default if a name isn’t found.</span>
      </div>

      <div className="form-block">
        <b>Layout</b>
        <div className="two-col">
          <div>
            <div className="mini-label">Corner roundness</div>
            <div className="segmented">
              {(Object.keys(RADIUS) as (keyof typeof RADIUS)[]).map((k) => (
                <button key={k} className={a.radius === k ? 'on' : ''} aria-pressed={a.radius === k} onClick={() => updateAppearance({ radius: k })}>{RADIUS[k].label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="mini-label">Chat width</div>
            <div className="segmented">
              {(Object.keys(CHAT_WIDTH) as (keyof typeof CHAT_WIDTH)[]).map((k) => (
                <button key={k} className={a.chatWidth === k ? 'on' : ''} aria-pressed={a.chatWidth === k} onClick={() => updateAppearance({ chatWidth: k })}>{CHAT_WIDTH[k].label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="form-actions">
        <button className="btn" onClick={() => confirm('Reset accent, fonts, size and layout to defaults? Your themes are kept.') && updateAppearance({ ...DEFAULT_APPEARANCE, darkTheme: a.darkTheme, lightTheme: a.lightTheme, customThemes: a.customThemes })}>
          Reset appearance options
        </button>
      </div>
    </div>
  )
}

/** Free-text font input: commits on blur/Enter so every keystroke doesn't re-layout the app. */
function FontInput({ value, onCommit, placeholder }: { value: string; onCommit(v: string): void; placeholder: string }) {
  const [v, setV] = useState(value)
  return (
    <input
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

// ---------------------------------------------------------------- editor

function ThemeEditor({ initial, onDone }: { initial: EditorState; onDone(): void }) {
  const { settings, updateAppearance, setPreviewTheme, setSettings, showToast } = useStore()
  const setModeTo = async (theme: ThemeSetting) => {
    setSettings({ ...useStore.getState().settings!, theme })
    await window.api.settings.update({ theme })
  }
  const [name, setName] = useState(initial.name)
  const [colors, setColors] = useState<ThemeColors>(initial.colors)
  const base = initial.base
  const a = settings!.appearance

  // Live preview: the whole app re-themes as you edit; cleared on leave.
  useEffect(() => {
    setPreviewTheme({ base, colors })
  }, [colors, base, setPreviewTheme])
  useEffect(() => () => setPreviewTheme(null), [setPreviewTheme])

  const checks = useMemo(() => contrastChecks(colors), [colors])
  const failing = checks.filter((c) => !c.ok)

  const save = async () => {
    const id = initial.id ?? newId()
    const theme: CustomTheme = { id, name: name.trim() || 'My theme', base, custom: true, colors }
    const others = a.customThemes.filter((t) => t.id !== id)
    updateAppearance({ customThemes: [...others, theme], ...(base === 'dark' ? { darkTheme: id } : { lightTheme: id }) })
    // Make sure the new theme is actually what the user sees.
    const mode = settings!.theme
    const active = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode
    if (active !== base) await setModeTo(base)
    onDone()
  }

  const setColor = (k: ColorKey, v: string) => setColors((c) => ({ ...c, [k]: v }))

  return (
    <div className="form">
      <div className="modal-head inline"><h3>{initial.id ? 'Edit theme' : 'New theme'} <span className="risk">{base}</span></h3></div>
      <label>
        Name
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <span className="hint">The whole app previews your changes live. Nothing is saved until you press Save.</span>
      </label>

      {COLOR_GROUPS.map((g) => (
        <div className="form-block" key={g.title}>
          <b>{g.title}</b>
          <div className="color-grid">
            {g.keys.map(({ key, label }) => <ColorRow key={key} label={label} value={colors[key]} onChange={(v) => setColor(key, v)} />)}
          </div>
        </div>
      ))}

      <div className="form-block">
        <b>Readability {failing.length === 0 ? <span className="pill ok">all checks pass</span> : <span className="pill bad">{failing.length} below recommended</span>}</b>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'ok' : 'bad'}>
              <span aria-hidden>{c.ok ? '✓' : '✕'}</span> {c.label} <span className="muted">{c.ratio}:1 <small>(aim ≥ {c.min})</small></span>
            </li>
          ))}
        </ul>
        <span className="hint">Based on WCAG contrast. Low scores don’t block saving — they’re a guide.</span>
      </div>

      <div className="form-actions">
        <button className="btn primary" onClick={save}>Save theme</button>
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn" onClick={() => setColors({ ...initial.colors })}>Revert changes</button>
        <button className="btn" onClick={async () => { await navigator.clipboard.writeText(exportTheme({ id: 'x', name, base, colors })); showToast('Theme copied as JSON') }}>Copy JSON</button>
      </div>
    </div>
  )
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const valid = normalizeHex(text) !== null
  return (
    <label className="color-row">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} colour`} />
      <span className="color-label">{label}</span>
      <input
        className={`hex ${valid ? '' : 'invalid'}`}
        value={text}
        spellCheck={false}
        aria-label={`${label} hex value`}
        onChange={(e) => {
          setText(e.target.value)
          const n = normalizeHex(e.target.value)
          if (n) onChange(n)
        }}
        onBlur={() => setText(value)}
      />
    </label>
  )
}

function ImportTheme({ onDone, onParsed }: { onDone(): void; onParsed(e: EditorState): void }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  return (
    <div className="form">
      <div className="modal-head inline"><h3>Import theme</h3></div>
      <label>
        Paste theme JSON
        <textarea className="mono" rows={10} value={text} onChange={(e) => { setText(e.target.value); setErr('') }} spellCheck={false} placeholder={'{\n  "talariaTheme": 1,\n  "name": "…",\n  "base": "dark",\n  "colors": { "bg": "#101010", … }\n}'} />
        <span className="hint">From “Export” / “Copy JSON”. You can review and adjust it before saving.</span>
      </label>
      {err && <div className="status bad">{err}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={!text.trim()} onClick={() => {
          const r = parseThemeFile(text)
          if ('error' in r) setErr(r.error)
          else onParsed({ name: r.name, base: r.base, colors: r.colors })
        }}>Review theme</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

