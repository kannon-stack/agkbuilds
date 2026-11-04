import { useEffect, useMemo, useRef, useState } from 'react'
import { ModelPicker } from './ModelPicker'
import { useStore } from '../store'
import { applicableMemories } from '../../../shared/memory'

interface Props {
  generating: boolean
  disabled: boolean
  onSend(text: string): void
  onStop(): void
}

interface Command {
  name: string
  description: string
  kind: 'builtin' | 'skill'
}

export function Composer({ generating, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const { settings, skills, memory, openSettings, refreshMemory, showToast } = useStore()
  const tools = settings?.tools
  const memoryOn = !!settings?.memory.enabled
  const folder = tools?.workspace.split(/[\\/]/).filter(Boolean).pop()
  const noteCount = useMemo(() => (memoryOn ? applicableMemories(memory, tools?.workspace ?? '').length : 0), [memory, memoryOn, tools?.workspace])
  const skillCount = settings?.skills.enabled ? skills.filter((s) => s.enabled).length : 0

  // Auto-grow up to ~40% of the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  // Slash commands: built-ins + enabled skills, shown while you're typing "/name".
  const commands = useMemo<Command[]>(
    () => [
      ...(memoryOn ? [{ name: 'remember', description: 'Save a note to memory — /remember I prefer tabs', kind: 'builtin' as const }] : []),
      ...(settings?.skills.enabled ? skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, kind: 'skill' as const })) : [])
    ],
    [memoryOn, skills, settings?.skills.enabled]
  )
  const prefix = /^\/([a-z0-9-]*)$/.exec(text)?.[1]
  const matches = useMemo(() => (prefix === undefined ? [] : commands.filter((c) => c.name.startsWith(prefix)).slice(0, 8)), [prefix, commands])
  const menuOpen = !dismissed && matches.length > 0
  useEffect(() => { setSel(0); setDismissed(false) }, [prefix])

  const complete = (c: Command) => {
    setText(`/${c.name} `)
    setDismissed(true)
    ref.current?.focus()
  }

  const submit = async () => {
    const t = text.trim()
    if (!t || generating || disabled) return
    // /remember <note>: handled locally — saves instantly, no model call.
    const rem = /^\/remember(?:\s+([\s\S]*))?$/.exec(t)
    if (rem && memoryOn) {
      const note = (rem[1] ?? '').trim()
      if (!note) return showToast('Usage: /remember <something to remember>')
      const r = await window.api.memory.add(note, 'global')
      showToast(r.ok ? 'Remembered' : r.error)
      if (r.ok) { setText(''); await refreshMemory() }
      return
    }
    onSend(t)
    setText('')
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        {menuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Commands">
            {matches.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === sel} className={`slash-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); complete(c) }}>
                <code>/{c.name}</code>
                <span className="slash-desc">{c.description}</span>
                <span className="risk">{c.kind === 'skill' ? 'skill' : 'command'}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus
          placeholder="Message… (Enter to send, Shift+Enter for a new line, / for commands)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (menuOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); return setSel((sel + 1) % matches.length) }
              if (e.key === 'ArrowUp') { e.preventDefault(); return setSel((sel - 1 + matches.length) % matches.length) }
              if (e.key === 'Escape') { e.preventDefault(); return setDismissed(true) }
              const c = matches[sel]
              // Tab always completes; Enter completes unless the command is already fully typed (then it sends).
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (text.trim() !== `/${c.name}` || c.kind === 'builtin'))) { e.preventDefault(); return complete(c) }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-left">
            <ModelPicker />
            <button
              className={`chip ${tools?.enabled ? 'on' : ''}`}
              onClick={() => openSettings(true, 'tools')}
              title={tools?.enabled ? `Tools enabled. Workspace: ${tools.workspace || 'none chosen'}` : 'Tools are off'}
            >
              🛠 {tools?.enabled ? (folder ?? 'no folder') : 'Tools off'}
            </button>
            {memoryOn && (
              <button className="chip on" onClick={() => openSettings(true, 'memory')} title={`${noteCount} memory note${noteCount === 1 ? '' : 's'} shared with the model in this chat`}>
                🧠 {noteCount}
              </button>
            )}
            {skillCount > 0 && (
              <button className="chip on" onClick={() => openSettings(true, 'skills')} title={`${skillCount} skill${skillCount === 1 ? '' : 's'} available — type / to use one`}>
                ⚡ {skillCount}
              </button>
            )}
          </div>
          {generating ? (
            <button className="send stop" onClick={onStop} aria-label="Stop generating" title="Stop">
              ■
            </button>
          ) : (
            <button className="send" onClick={() => void submit()} disabled={!text.trim() || disabled} aria-label="Send" title="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
