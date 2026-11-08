import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_MODEL, DEFAULT_ANTHROPIC_OPTIONS, EFFORT_LABELS, fallbackEligible, type AnthropicOptions, type ProviderKind } from '../../../shared/anthropic'
import type { AppInfo, ConnectionResult, Provider } from '../../../shared/types'
import { McpSettings } from './McpSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { MemorySettings } from './MemorySettings'
import { SkillsSettings } from './SkillsSettings'
import { TOOL_META, type ToolPolicy } from '../../../shared/toolMeta'
import { MAX_USER_NAME } from '../../../shared/greeting'
import { Icon, type IconName } from './Icons'

type Tab = 'general' | 'providers' | 'tools' | 'mcp' | 'appearance' | 'memory' | 'skills'

const SECTIONS: { id: Tab; label: string; icon: IconName; blurb: string }[] = [
  { id: 'providers', label: 'Providers', icon: 'server', blurb: 'The services Talaria uses to reach models.' },
  { id: 'tools', label: 'Tools', icon: 'tools', blurb: 'What the model may do on your computer, and where.' },
  { id: 'memory', label: 'Memory', icon: 'memory', blurb: 'Notes the model remembers between chats.' },
  { id: 'skills', label: 'Skills', icon: 'book', blurb: 'Reusable instructions you can run with /name.' },
  { id: 'mcp', label: 'MCP servers', icon: 'plug', blurb: 'Connect extra tools from MCP servers.' },
  { id: 'appearance', label: 'Appearance', icon: 'drop', blurb: 'Themes, colours, fonts and layout.' },
  { id: 'general', label: 'General', icon: 'sliders', blurb: 'Your name, the system prompt, chat titles and context.' }
]

/** Full-page settings: a section menu in the sidebar's place and one section at a time. */
export function SettingsModal() {
  const { settings, setSettings, openSettings, loadModels, settingsTab } = useStore()
  const [tab, setTab] = useState<Tab>(settingsTab)
  useEffect(() => setTab(settingsTab), [settingsTab])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.overlay') && openSettings(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [openSettings])

  if (!settings) return null
  const close = () => {
    openSettings(false)
    void loadModels()
  }
  const section = SECTIONS.find((x) => x.id === tab)!

  return (
    <section className="settings-page" aria-label="Settings">
      <nav className="settings-menu tabs" aria-label="Settings sections">
        <button className="settings-back" onClick={close} aria-label="Close settings">
          <Icon name="back" size={16} /> Back to chat
        </button>
        {SECTIONS.map((x) => (
          <button key={x.id} className={tab === x.id ? 'on' : ''} aria-current={tab === x.id ? 'page' : undefined} onClick={() => setTab(x.id)}>
            <Icon name={x.icon} size={17} /> {x.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-col">
          <header className="settings-head">
            <h2>{section.label}</h2>
            <p>{section.blurb}</p>
          </header>
          <div className="settings-card">
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
    </section>
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
  const [name, setName] = useState(settings!.userName)
  const [prompt, setPrompt] = useState(settings!.systemPrompt)
  const [temp, setTemp] = useState(settings!.temperature)
  const update = async (patch: Parameters<typeof window.api.settings.update>[0]) =>
    setSettings(await window.api.settings.update(patch))

  return (
    <div className="form">
      <label>
        What should Talaria call you?
        <input value={name} maxLength={MAX_USER_NAME} placeholder="Your first name" onChange={(e) => setName(e.target.value)} onBlur={() => update({ userName: name })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className="hint">Used in the greeting on new chats. It stays on this computer and is not sent to the model.</span>
      </label>
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
      <Titles />
      <Context />
      <About />
    </div>
  )
}

function Titles() {
  const { settings, patchSettings } = useStore()
  const t = settings!.titles
  const [model, setModel] = useState(t.model)
  return (
    <div className="ctx-settings">
      <h3 className="subhead">Chat titles</h3>
      <label className="check switch">
        <input type="checkbox" checked={t.enabled} onChange={(e) => void patchSettings({ titles: { enabled: e.target.checked } })} />
        <span>
          <b>Let the model name new chats</b>
          <span className="hint"> After the first reply, a short title replaces the placeholder (your first message). Titles you type yourself are never changed.</span>
        </span>
      </label>
      <label>
        Model for titles
        <input
          placeholder="Same as the chat" value={model} disabled={!t.enabled} spellCheck={false}
          onChange={(e) => setModel(e.target.value)} onBlur={() => void patchSettings({ titles: { model } })}
        />
        <span className="hint">A small, fast model is plenty (used with the chat’s provider), e.g. claude-haiku-5-5. Leave empty to use the chat’s own model.</span>
      </label>
    </div>
  )
}

function Context() {
  const { settings, patchSettings } = useStore()
  const c = settings!.context
  const [threshold, setThreshold] = useState(c.threshold)
  const [windowText, setWindowText] = useState(c.window ? String(c.window) : '')
  return (
    <div className="ctx-settings">
      <h3 className="subhead">Context</h3>
      <label className="check switch">
        <input type="checkbox" checked={c.auto} onChange={(e) => void patchSettings({ context: { auto: e.target.checked } })} />
        <span>
          <b>Summarize older messages automatically</b>
          <span className="hint"> When a chat nears the model’s context window, older turns are condensed into a summary (the full chat stays visible). Turn off to only trim old tool results and drop the oldest turns when needed.</span>
        </span>
      </label>
      <label>
        Summarize at <b>{Math.round(threshold * 100)}%</b> of the window
        <input
          type="range" min={50} max={95} step={5} value={Math.round(threshold * 100)} disabled={!c.auto}
          onChange={(e) => setThreshold(+e.target.value / 100)}
          onMouseUp={() => void patchSettings({ context: { threshold } })} onKeyUp={() => void patchSettings({ context: { threshold } })}
        />
      </label>
      <label>
        Context window (tokens)
        <input
          type="number" min={0} step={1000} placeholder="Auto-detect" value={windowText}
          onChange={(e) => setWindowText(e.target.value)}
          onBlur={() => void patchSettings({ context: { window: Math.max(0, parseInt(windowText, 10) || 0) } })}
        />
        <span className="hint">Leave empty to detect it from the provider or model name. Set it for local or custom models whose limit differs (e.g. 32768).</span>
      </label>
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

  const addClaude = async () => {
    const s = await window.api.settings.saveProvider({
      name: 'Claude (Anthropic)', kind: 'anthropic', baseUrl: ANTHROPIC_BASE_URL, defaultModel: ANTHROPIC_DEFAULT_MODEL, options: DEFAULT_ANTHROPIC_OPTIONS
    })
    onChange(s)
    setSelected(s.providers.at(-1)!.id)
  }

  return (
    <div className="providers">
      <div className="provider-list">
        {providers.map((p) => (
          <button key={p.id} className={p.id === selected ? 'on' : ''} onClick={() => setSelected(p.id)}>
            <span className="prov-name">{p.name}</span>
            {p.kind === 'anthropic' && <small className="kind">claude</small>}
            {p.id === activeId && <small>active</small>}
          </button>
        ))}
        <button className="add" onClick={addClaude}>
          ＋ Add Claude
        </button>
        <button className="add" onClick={add}>
          ＋ Add other provider
        </button>
      </div>
      {current && <ProviderForm key={current.id} provider={current} canDelete={providers.length > 1} onChange={onChange} />}
    </div>
  )
}

function ProviderForm({ provider, canDelete, onChange }: { provider: Provider; canDelete: boolean; onChange: (s: any) => void }) {
  const [name, setName] = useState(provider.name)
  const [kind, setKind] = useState<ProviderKind>(provider.kind)
  const [options, setOptions] = useState<AnthropicOptions>(provider.options ?? DEFAULT_ANTHROPIC_OPTIONS)
  const claude = kind === 'anthropic'
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel)
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)

  const test = async () => {
    setTesting(true)
    setResult(await window.api.models.test(baseUrl, apiKey || undefined, provider.id, kind))
    setTesting(false)
  }
  const save = async () => {
    const s = await window.api.settings.saveProvider({
      id: provider.id,
      name,
      kind,
      ...(claude ? { options } : {}),
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
        Type
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as ProviderKind
            setKind(k)
            setResult(null)
            // Switching type: swap in sensible defaults only where the field still holds the other type's default.
            if (k === 'anthropic') {
              if (!baseUrl || /localhost|127\.0\.0\.1/.test(baseUrl)) setBaseUrl(ANTHROPIC_BASE_URL)
              if (!defaultModel) setDefaultModel(ANTHROPIC_DEFAULT_MODEL)
            } else if (baseUrl === ANTHROPIC_BASE_URL) setBaseUrl('http://localhost:20128/v1')
          }}
        >
          <option value="openai">OpenAI-compatible (9router, Ollama, OpenRouter, vLLM…)</option>
          <option value="anthropic">Claude — native Anthropic API</option>
        </select>
      </label>
      <label>
        {claude ? 'API URL' : 'Base URL'}
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={claude ? ANTHROPIC_BASE_URL : 'http://localhost:20128/v1'} spellCheck={false} />
        <span className="hint">
          {claude ? (
            <>Leave as <code>{ANTHROPIC_BASE_URL}</code> unless you use a gateway. Uses the Messages API with streaming, tools and prompt caching.</>
          ) : (
            <>Any OpenAI-compatible endpoint. We call <code>/chat/completions</code> and <code>/models</code>.</>
          )}
        </span>
      </label>
      <label>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setClearKey(false) }}
          placeholder={provider.hasKey && !clearKey ? '•••••••• saved (leave blank to keep)' : claude ? 'sk-ant-…  (or set ANTHROPIC_API_KEY)' : 'Optional for local servers'}
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
        <input list={`models-${provider.id}`} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder={claude ? ANTHROPIC_DEFAULT_MODEL : 'e.g. cc/claude-opus-4-7'} spellCheck={false} />
        <datalist id={`models-${provider.id}`}>{result?.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>

      {claude && (
        <div className="form-block claude-opts">
          <b>Claude options</b>
          <label>
            Effort
            <select value={options.effort} onChange={(e) => setOptions({ ...options, effort: e.target.value as AnthropicOptions['effort'] })}>
              <option value="">Model default</option>
              {Object.entries(EFFORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <span className="hint">How hard Claude thinks. Higher = slower and costlier. Not every model supports every level; unsupported values are skipped when the model says so.</span>
          </label>
          <label className="check"><input type="checkbox" checked={options.showThinking} onChange={(e) => setOptions({ ...options, showThinking: e.target.checked })} /> Show reasoning summaries</label>
          <label className="check"><input type="checkbox" checked={options.promptCaching} onChange={(e) => setOptions({ ...options, promptCaching: e.target.checked })} /> Prompt caching (re-reads repeated context at ~10% of the price)</label>
          <label className="check">
            <input type="checkbox" checked={options.refusalFallback} onChange={(e) => setOptions({ ...options, refusalFallback: e.target.checked })} /> Automatic refusal fallback
          </label>
          <span className="hint">
            When Claude declines a request, retry on a fallback model server-side. Only available on {fallbackEligible(defaultModel || ANTHROPIC_DEFAULT_MODEL, baseUrl || ANTHROPIC_BASE_URL) ? 'this model' : 'Claude Fable/Opus 5.x and Sonnet 5.5 via the official API — not used for the current model/URL'}.
          </span>
          <span className="hint">The temperature setting isn’t sent to Claude — newer models reject it.</span>
        </div>
      )}

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
