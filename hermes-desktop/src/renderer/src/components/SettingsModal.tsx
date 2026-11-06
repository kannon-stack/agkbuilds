import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { AppInfo, ConnectionResult, Provider } from '../../../shared/types'
import { McpSettings } from './McpSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { MemorySettings } from './MemorySettings'
import { SkillsSettings } from './SkillsSettings'
import { TOOL_META, type ToolPolicy } from '../../../shared/toolMeta'

type Tab = 'general' | 'providers' | 'tools' | 'mcp' | 'appearance' | 'memory' | 'skills'

export function SettingsModal() {
  const { settings, setSettings, openSettings, loadModels, settingsTab } = useStore()
  const [tab, setTab] = useState<Tab>(settingsTab)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && openSettings(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [openSettings])

  if (!settings) return null
  const close = () => {
    openSettings(false)
    void loadModels()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal aria-label="Settings">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} aria-label="Close settings">
            ✕
          </button>
        </div>
        <div className="tabs">
          {(['providers', 'tools', 'memory', 'skills', 'mcp', 'appearance', 'general'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'general' ? 'General' : t === 'tools' ? 'Tools' : t === 'mcp' ? 'MCP' : t === 'appearance' ? 'Appearance' : t === 'memory' ? 'Memory' : t === 'skills' ? 'Skills' : 'Providers'}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'general' ? (
            <General />
          ) : tab === 'tools' ? (
            <Tools />
          ) : tab === 'mcp' ? (
            <McpSettings />
          ) : tab === 'appearance' ? (
            <AppearanceSettings />
          ) : tab === 'memory' ? (
            <MemorySettings />
          ) : tab === 'skills' ? (
            <SkillsSettings />
          ) : (
            <Providers providers={settings.providers} activeId={settings.activeProviderId} onChange={setSettings} />
          )}
        </div>
      </div>
    </div>
  )
}

function Tools() {
  const { settings, patchSettings } = useStore()
  const t = settings!.tools
  const patch = (p: Parameters<typeof window.api.settings.update>[0]) => patchSettings(p)
  const pick = async () => {
    const dir = await window.api.settings.pickWorkspace()
    if (dir) await patch({ tools: { workspace: dir } })
  }
  const policy = (name: string, def: ToolPolicy) => t.policies[name] ?? def

  return (
    <div className="form">
      <label className="check switch">
        <input type="checkbox" checked={t.enabled} onChange={(e) => patch({ tools: { enabled: e.target.checked } })} />
        <span>
          <b>Let the model use tools</b>
          <span className="hint"> Requires a model that supports OpenAI-style tool calling. Turn off if a model errors on tools.</span>
        </span>
      </label>

      <div className="form-block">
        <b>Workspace folder</b>
        <div className="ws-row">
          <code className="ws-path">{t.workspace || 'None chosen — file and command tools are unavailable'}</code>
          <button className="btn" onClick={pick}>{t.workspace ? 'Change…' : 'Choose folder…'}</button>
          {t.workspace && <button className="btn" onClick={() => patch({ tools: { workspace: '' } })}>Clear</button>}
        </div>
        <span className="hint">
          File tools can read here freely and write only here. Reading anything outside it always asks. Shell commands start here but are <b>not sandboxed</b>.
        </span>
      </div>

      <div className="form-block">
        <b>Permissions</b>
        <table className="perm">
          <tbody>
            {TOOL_META.map((m) => (
              <tr key={m.name} className={m.needsWorkspace && !t.workspace ? 'dim' : ''}>
                <td>
                  <div>{m.label} <span className={`risk risk-${m.risk}`}>{m.risk}</span></div>
                  <div className="hint">{m.description}</div>
                </td>
                <td>
                  <select
                    value={policy(m.name, m.defaultPolicy)}
                    onChange={(e) => patch({ tools: { policies: { [m.name]: e.target.value as ToolPolicy } } })}
                  >
                    <option value="ask">Ask each time</option>
                    <option value="allow">Always allow</option>
                    <option value="deny">Disabled</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="hint warn">
          “Always allow” on shell commands or web fetches lets the model act without asking — including after reading untrusted content (a web page or file can contain hidden instructions).
        </span>
      </div>
    </div>
  )
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const { showToast } = useStore()
  useEffect(() => {
    void window.api.app.info().then(setInfo)
  }, [])
  if (!info) return null
  const diag = `${info.name} ${info.version}${info.packaged ? '' : ' (dev)'}\nElectron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}\n${info.platform} ${info.arch}\nData: ${info.dataDir}`
  return (
    <div className="form-block">
      <b>About</b>
      <div className="about">
        <div><b>{info.name}</b> {info.version}{!info.packaged && <span className="risk">dev build</span>}</div>
        <div className="muted small">Electron {info.electron} · Chromium {info.chrome} · {info.platform} {info.arch}</div>
        <code className="mono-small">{info.dataDir}</code>
      </div>
      <div className="form-actions">
        <button className="btn" onClick={() => window.api.app.openDataFolder()}>Open data folder</button>
        <button className="btn" onClick={async () => { await navigator.clipboard.writeText(diag); showToast('Diagnostics copied') }}>Copy diagnostics</button>
      </div>
      <span className="hint">Your chats, memory, skills and settings live in the data folder. Uninstalling the app never deletes it.</span>
    </div>
  )
}

function General() {
  const { settings, setSettings } = useStore()
  const [prompt, setPrompt] = useState(settings!.systemPrompt)
  const [temp, setTemp] = useState(settings!.temperature)
  const update = async (patch: Parameters<typeof window.api.settings.update>[0]) =>
    setSettings(await window.api.settings.update(patch))

  return (
    <div className="form">
      <label>
        System prompt
        <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => update({ systemPrompt: prompt })} />
        <span className="hint">Sent at the start of every conversation.</span>
      </label>
      <label>
        Temperature <b>{temp.toFixed(1)}</b>
        <input type="range" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(+e.target.value)} onMouseUp={() => update({ temperature: temp })} onKeyUp={() => update({ temperature: temp })} />
        <span className="hint">Lower is more focused, higher is more creative.</span>
      </label>
      <About />
    </div>
  )
}

function Providers({ providers, activeId, onChange }: { providers: Provider[]; activeId: string; onChange: (s: any) => void }) {
  const [selected, setSelected] = useState<string>(activeId)
  const current = providers.find((p) => p.id === selected)

  const add = async () => {
    const s = await window.api.settings.saveProvider({ name: 'New provider', baseUrl: 'http://localhost:20128/v1', defaultModel: '' })
    onChange(s)
    setSelected(s.providers.at(-1)!.id)
  }

  return (
    <div className="providers">
      <div className="provider-list">
        {providers.map((p) => (
          <button key={p.id} className={p.id === selected ? 'on' : ''} onClick={() => setSelected(p.id)}>
            {p.name}
            {p.id === activeId && <small>active</small>}
          </button>
        ))}
        <button className="add" onClick={add}>
          ＋ Add provider
        </button>
      </div>
      {current && <ProviderForm key={current.id} provider={current} canDelete={providers.length > 1} onChange={onChange} />}
    </div>
  )
}

function ProviderForm({ provider, canDelete, onChange }: { provider: Provider; canDelete: boolean; onChange: (s: any) => void }) {
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel)
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)

  const test = async () => {
    setTesting(true)
    setResult(await window.api.models.test(baseUrl, apiKey || undefined, provider.id))
    setTesting(false)
  }
  const save = async () => {
    const s = await window.api.settings.saveProvider({
      id: provider.id,
      name,
      baseUrl,
      defaultModel,
      apiKey: clearKey ? '' : apiKey || undefined
    })
    onChange(s)
    setApiKey('')
    setClearKey(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="form provider-form">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Base URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:20128/v1" spellCheck={false} />
        <span className="hint">Any OpenAI-compatible endpoint (9router, Ollama, OpenRouter, vLLM…). We call <code>/chat/completions</code> and <code>/models</code>.</span>
      </label>
      <label>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setClearKey(false) }}
          placeholder={provider.hasKey && !clearKey ? '•••••••• saved (leave blank to keep)' : 'Optional for local servers'}
          autoComplete="off"
        />
        {provider.hasKey && (
          <label className="check">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove saved key
          </label>
        )}
        {provider.keyPlain ? (
          <span className="hint warn">
            No OS keychain was found, so this key is stored unencrypted in a private (owner-only) file. Install gnome-keyring or KWallet to encrypt it.
          </span>
        ) : (
          <span className="hint">Encrypted with your OS keychain. The key stays in the main process and is never sent to the UI.</span>
        )}
      </label>
      <label>
        Default model
        <input list={`models-${provider.id}`} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="e.g. cc/claude-opus-4-7" spellCheck={false} />
        <datalist id={`models-${provider.id}`}>{result?.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>

      {result && (
        <div className={`status ${result.ok ? 'ok' : 'bad'}`} role="status">
          {result.ok ? `Connected — ${result.models.length} model${result.models.length === 1 ? '' : 's'} available.` : result.error}
        </div>
      )}

      <div className="form-actions">
        <button className="btn" onClick={test} disabled={testing || !baseUrl}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn primary" onClick={save}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
        {canDelete && (
          <button
            className="btn danger"
            onClick={async () => confirm(`Remove provider “${provider.name}”?`) && onChange(await window.api.settings.removeProvider(provider.id))}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}
