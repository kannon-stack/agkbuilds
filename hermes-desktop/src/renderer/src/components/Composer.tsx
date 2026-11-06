import { useEffect, useMemo, useRef, useState } from 'react'
import { ModelPicker } from './ModelPicker'
import { useStore } from '../store'
import { applicableMemories } from '../../../shared/memory'
import { MAX_ATTACHMENTS_PER_MESSAGE, IMAGE_MIMES } from '../../../shared/attachments'
import type { Attachment } from '../../../shared/types'
import { prepareImage } from '../images'
import { Thumbs } from './Thumbs'
import { ContextMeter } from './ContextMeter'

interface Props {
  generating: boolean
  disabled: boolean
  onSend(text: string, attachments?: Attachment[]): void
  onStop(): void
}

interface Command {
  name: string
  description: string
  kind: 'builtin' | 'skill'
  /** Fully typed, Enter runs it (its argument is optional). */
  runsAlone?: boolean
}

export function Composer({ generating, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [files, setFiles] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const { settings, skills, memory, openSettings, refreshMemory, showToast, compact, compacting, active } = useStore()
  const summarizing = !!active && !!compacting[active.id]
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
      { name: 'compact', description: 'Summarize older messages to free up context — /compact focus on the API design', kind: 'builtin' as const, runsAlone: true },
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

  // Save images (picked, pasted or dropped) and show them as thumbnails until the message is sent.
  const addBlobs = async (items: { blob: Blob; name: string }[]) => {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - files.length
    if (items.length > room) showToast(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`)
    for (const it of items.slice(0, Math.max(0, room))) {
      try {
        const { name, bytes } = await prepareImage(it.blob, it.name)
        const r = await window.api.attachments.save(name, bytes)
        if (!r.ok) showToast(r.error)
        else setFiles((cur) => (cur.some((x) => x.id === r.value.id) || cur.length >= MAX_ATTACHMENTS_PER_MESSAGE ? cur : [...cur, r.value]))
      } catch (e) {
        showToast((e as Error).message)
      }
    }
  }
  const pick = async () => {
    const r = await window.api.attachments.pick()
    if (!r.ok) return showToast(r.error)
    setFiles((cur) => [...cur, ...r.value.filter((a) => !cur.some((x) => x.id === a.id))].slice(0, MAX_ATTACHMENTS_PER_MESSAGE))
  }
  const imagesIn = (list: FileList | null | undefined) =>
    [...(list ?? [])].filter((f) => (IMAGE_MIMES as readonly string[]).includes(f.type)).map((f) => ({ blob: f as Blob, name: f.name || 'pasted-image' }))

  const submit = async () => {
    const t = text.trim()
    if ((!t && !files.length) || generating || summarizing || disabled) return
    // /compact [focus]: summarize older messages now — handled locally.
    const cmp = files.length ? null : /^\/compact(?:\s+([\s\S]*))?$/.exec(t)
    if (cmp) {
      setText('')
      void compact(cmp[1])
      return
    }
    // /remember <note>: handled locally — saves instantly, no model call.
    const rem = files.length ? null : /^\/remember(?:\s+([\s\S]*))?$/.exec(t)
    if (rem && memoryOn) {
      const note = (rem[1] ?? '').trim()
      if (!note) return showToast('Usage: /remember <something to remember>')
      const r = await window.api.memory.add(note, 'global')
      showToast(r.ok ? 'Remembered' : r.error)
      if (r.ok) { setText(''); await refreshMemory() }
      return
    }
    onSend(t, files.length ? files : undefined)
    setText('')
    setFiles([])
  }

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
        onDrop={(e) => {
          setDragging(false)
          const imgs = imagesIn(e.dataTransfer.files)
          if (e.dataTransfer.files.length && !imgs.length) showToast('Only PNG, JPEG, GIF and WebP images can be attached.')
          if (imgs.length) {
            e.preventDefault()
            void addBlobs(imgs)
          }
        }}
      >
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
        <Thumbs items={files} onRemove={(id) => setFiles((cur) => cur.filter((x) => x.id !== id))} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus
          placeholder="Message… (Enter to send, Shift+Enter for a new line, / for commands)"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const imgs = imagesIn(e.clipboardData.files)
            if (imgs.length) {
              e.preventDefault()
              void addBlobs(imgs)
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (menuOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); return setSel((sel + 1) % matches.length) }
              if (e.key === 'ArrowUp') { e.preventDefault(); return setSel((sel - 1 + matches.length) % matches.length) }
              if (e.key === 'Escape') { e.preventDefault(); return setDismissed(true) }
              const c = matches[sel]
              // Tab always completes; Enter completes unless the command is already fully typed (then it sends).
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (text.trim() !== `/${c.name}` || (c.kind === 'builtin' && !c.runsAlone)))) { e.preventDefault(); return complete(c) }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-left">
            <button className="attach-btn" onClick={() => void pick()} title="Attach images (or paste / drop them)" aria-label="Attach images" disabled={files.length >= MAX_ATTACHMENTS_PER_MESSAGE}>
              📎
            </button>
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
            <ContextMeter busy={generating || summarizing} />
            {skillCount > 0 && (
              <button className="chip on" onClick={() => openSettings(true, 'skills')} title={`${skillCount} skill${skillCount === 1 ? '' : 's'} available — type / to use one`}>
                ⚡ {skillCount}
              </button>
            )}
          </div>
          {generating || summarizing ? (
            <button className="send stop" onClick={onStop} aria-label="Stop generating" title="Stop">
              ■
            </button>
          ) : (
            <button className="send" onClick={() => void submit()} disabled={(!text.trim() && !files.length) || disabled} aria-label="Send" title="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
