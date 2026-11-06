import { useEffect, useRef } from 'react'
import { applyAppearance } from './applyTheme'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsModal } from './components/SettingsModal'

export default function App() {
  const { ready, init, settings, settingsOpen, toast, newChat, openSettings, previewTheme } = useStore()
  const revealed = useRef(false)

  useEffect(() => {
    void init()
  }, [init])

  // Theme: resolve (mode + chosen themes + accent/fonts/shape) → CSS variables. Re-run when the
  // OS theme flips (system mode) or while the theme editor previews unsaved colours.
  useEffect(() => {
    if (!settings) return
    const apply = () => applyAppearance(settings, previewTheme)
    apply()
    if (!revealed.current) {
      revealed.current = true
      // First paint with the right theme is done: now the (hidden) window can be shown.
      requestAnimationFrame(() => void window.api.app.rendered())
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings, previewTheme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); void newChat() }
      if (e.key === ',') { e.preventDefault(); openSettings(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat, openSettings])

  if (!ready) return <div className="boot" />
  return (
    <div className="app">
      <Sidebar />
      <ChatView />
      {settingsOpen && <SettingsModal />}
      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  )
}
