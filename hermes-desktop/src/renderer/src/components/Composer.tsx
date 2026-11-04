import { useEffect, useRef, useState } from 'react'
import { ModelPicker } from './ModelPicker'
import { useStore } from '../store'

interface Props {
  generating: boolean
  disabled: boolean
  onSend(text: string): void
  onStop(): void
}

export function Composer({ generating, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const tools = useStore((s) => s.settings?.tools)
  const openSettings = useStore((s) => s.openSettings)
  const folder = tools?.workspace.split(/[\\/]/).filter(Boolean).pop()

  // Auto-grow up to ~40% of the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || generating || disabled) return
    onSend(t)
    setText('')
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus
          placeholder="Message… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
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
          </div>
          {generating ? (
            <button className="send stop" onClick={onStop} aria-label="Stop generating" title="Stop">
              ■
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send" title="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
