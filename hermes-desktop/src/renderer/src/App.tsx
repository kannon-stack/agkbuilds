import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsModal } from './components/SettingsModal'

export default function App() {
  const { ready, init, settings, settingsOpen, toast, newChat, openSettings } = useStore()

  useEffect(() => {
    void init()
  }, [init])

  // Theme: 'system' follows the OS, otherwise explicit.
  useEffect(() => {
    const pref = settings?.theme ?? 'system'
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings?.theme])

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
