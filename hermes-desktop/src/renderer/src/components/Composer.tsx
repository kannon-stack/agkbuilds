import { useEffect, useRef, useState } from 'react'
import { ModelPicker } from './ModelPicker'

interface Props {
  generating: boolean
  disabled: boolean
  onSend(text: string): void
  onStop(): void
}

export function Composer({ generating, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

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
          <ModelPicker />
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
