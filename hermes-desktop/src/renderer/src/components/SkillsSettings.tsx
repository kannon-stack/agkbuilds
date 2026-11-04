import { useState } from 'react'
import { useStore } from '../store'
import { SKILL_BODY_MAX, SKILL_DESC_MAX, validateSkillFields, type SkillFull, type SkillSummary } from '../../../shared/skills'

const SOURCE_LABEL = { user: 'yours', model: 'created by AI', workspace: 'from this project' } as const
const TEMPLATE = '## When to use\nDescribe the situations this skill is for.\n\n## Steps\n1. First step\n2. Second step\n'

export function SkillsSettings() {
  const { settings, skills, refreshSkills, refreshSettings, patchSettings, showToast } = useStore()
  const [editing, setEditing] = useState<{ original?: SkillFull; name: string } | 'new' | null>(null)
  const [open, setOpen] = useState<Record<string, SkillFull | null | undefined>>({})
  if (!settings) return null
  const enabled = settings.skills.enabled

  const toggle = async (s: SkillSummary, on: boolean) => {
    if (on && s.source === 'workspace' && !confirm(`Enable “${s.name}” from this project folder?\n\nIts instructions will be given to the model. Anyone who can edit this folder can change them, so only enable skills you trust. (Approval is revoked automatically if the file changes.)`)) return
    // Optimistic: flip it now; the refresh below reconciles with what was actually saved.
    useStore.setState((st) => ({ skills: st.skills.map((x) => (x.name === s.name && x.source === s.source ? { ...x, enabled: on, ...(s.source === 'workspace' ? { trusted: on, changed: false } : {}) } : x)) }))
    const r = await window.api.skills.setEnabled(s.name, on)
    if (!r.ok) showToast(r.error)
    await Promise.all([refreshSkills(), refreshSettings()])
  }
  const expand = async (s: SkillSummary) => {
    if (open[s.name]) return setOpen({ ...open, [s.name]: undefined })
    setOpen({ ...open, [s.name]: null })
    setOpen((o) => ({ ...o }))
    const full = await window.api.skills.get(s.name)
    setOpen((o) => ({ ...o, [s.name]: full }))
  }
  const remove = async (s: SkillSummary) => {
    if (!confirm(`Delete the skill “${s.name}” and its folder?`)) return
    const r = await window.api.skills.remove(s.name)
    if (!r.ok) showToast(r.error)
    await refreshSkills()
  }
  const edit = async (s: SkillSummary) => {
    const full = await window.api.skills.get(s.name)
    if (full) setEditing({ original: full, name: s.name })
  }
  const importFolder = async () => {
    const r = await window.api.skills.importFolder()
    if (!r) return
    showToast(r.ok ? `Imported “${r.value.name}”` : r.error)
    await refreshSkills()
  }

  if (editing) return <SkillForm initial={editing === 'new' ? undefined : editing.original} onDone={() => { setEditing(null); void refreshSkills() }} />

  const mine = skills.filter((s) => s.source !== 'workspace')
  const project = skills.filter((s) => s.source === 'workspace')

  const card = (s: SkillSummary) => {
    const full = open[s.name]
    return (
      <div key={`${s.source}:${s.name}`} className={`skill ${s.invalid ? 'invalid' : ''} ${s.enabled ? '' : 'off'}`}>
        <div className="skill-head">
          <code className="skill-name">/{s.name}</code>
          <span className={`risk ${s.source === 'workspace' ? 'risk-network' : ''}`}>{SOURCE_LABEL[s.source]}</span>
          <span className="spacer" />
          {!s.invalid && (
            <label className="check mcp-toggle" title={s.enabled ? 'Enabled' : 'Disabled'}>
              <input type="checkbox" checked={s.enabled} disabled={!enabled} onChange={(e) => toggle(s, e.target.checked)} /> On
            </label>
          )}
        </div>
        {s.invalid ? <div className="status bad">{s.invalid}</div> : <div className="skill-desc">{s.description}</div>}
        {s.source === 'workspace' && !s.invalid && !s.trusted && (
          <div className="tool-notice">
            {s.changed
              ? 'This skill changed since you enabled it, so it is off. Review it, then enable it again.'
              : 'Found in your project folder — not enabled. Review the instructions before turning it on.'}
          </div>
        )}
        <div className="mcp-actions">
          {!s.invalid && <button className="link-btn" onClick={() => expand(s)}>{full ? 'Hide' : 'View'} instructions</button>}
          {s.source !== 'workspace' && !s.invalid && <button className="link-btn" onClick={() => edit(s)}>Edit</button>}
          {s.source !== 'workspace' && <button className="link-btn danger-link" onClick={() => remove(s)}>Delete</button>}
          <span className="spacer" />
          <span className="muted small">{s.files.length} file{s.files.length === 1 ? '' : 's'}</span>
        </div>
        {full === null && <div className="muted small">Loading…</div>}
        {full && (
          <>
            <pre className="tool-pre skill-body">{full.body}</pre>
            {full.files.length > 1 && <div className="hint">Bundled files: {full.files.filter((f) => f !== 'SKILL.md').join(', ')}</div>}
            <div className="hint mono-small">{full.dir}</div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="form">
      <label className="check switch">
        <input type="checkbox" checked={enabled} onChange={(e) => void patchSettings({ skills: { enabled: e.target.checked } })} />
        <span>
          <b>Use skills</b>
          <span className="hint"> Skills are reusable instructions. The model sees a short list and loads a skill only when a task matches; you can also run one by typing <code>/skill-name</code> in a chat. They use the standard <code>SKILL.md</code> format, so existing skills work as-is.</span>
        </span>
      </label>

      <div className="form-actions">
        <button className="btn primary" disabled={!enabled} onClick={() => setEditing('new')}>＋ New skill</button>
        <button className="btn" disabled={!enabled} onClick={importFolder}>Import folder…</button>
        <button className="btn" onClick={() => window.api.skills.openFolder()}>Open skills folder</button>
        <button className="btn" onClick={refreshSkills}>Refresh</button>
      </div>

      <div className={`form-block ${enabled ? '' : 'dim'}`}>
        <b>Your skills</b>
        {mine.length === 0 && <p className="muted">None yet. Create one, import a folder, or drop a skill folder into the skills folder and press Refresh. You can also ask the model to “turn this into a skill”.</p>}
        {mine.map(card)}
      </div>

      <div className={`form-block ${enabled ? '' : 'dim'}`}>
        <b>Found in this project</b>
        {!settings.tools.workspace && <p className="muted small">Choose a workspace folder (Tools tab) to discover <code>.talaria/skills</code> and <code>.claude/skills</code> in it.</p>}
        {settings.tools.workspace && project.length === 0 && <p className="muted small">No skills in <code>.talaria/skills</code> or <code>.claude/skills</code> of this workspace.</p>}
        {project.map(card)}
      </div>
    </div>
  )
}

function SkillForm({ initial, onDone }: { initial?: SkillFull; onDone(): void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [body, setBody] = useState(initial?.body ?? TEMPLATE)
  const [err, setErr] = useState('')

  const save = async () => {
    const problem = validateSkillFields({ name, description, body })
    if (problem) return setErr(problem)
    const r = await window.api.skills.save({ name, description, body, originalName: initial?.name })
    if (!r.ok) return setErr(r.error)
    onDone()
  }

  return (
    <div className="form">
      <div className="modal-head inline"><h3>{initial ? `Edit ${initial.name}` : 'New skill'}</h3></div>
      <label>
        Name
        <input value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setErr('') }} placeholder="code-review" spellCheck={false} />
        <span className="hint">Lowercase letters, digits and hyphens. You’ll run it with <code>/{name || 'name'}</code>.</span>
      </label>
      <label>
        Description <span className="muted small">{description.length}/{SKILL_DESC_MAX}</span>
        <textarea rows={3} value={description} onChange={(e) => { setDescription(e.target.value); setErr('') }} placeholder="What it does and WHEN to use it — this is how the model decides to load it." />
      </label>
      <label>
        Instructions <span className="muted small">{body.length.toLocaleString()}/{SKILL_BODY_MAX.toLocaleString()}</span>
        <textarea className="mono" rows={14} value={body} onChange={(e) => { setBody(e.target.value); setErr('') }} spellCheck={false} />
        <span className="hint">Markdown. Be concrete: numbered steps, formats, things to avoid.</span>
      </label>
      {err && <div className="status bad">{err}</div>}
      <div className="form-actions">
        <button className="btn primary" onClick={save}>Save skill</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}
