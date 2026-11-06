import { useState } from 'react'
import { useStore } from '../store'
import type { McpImportResult, McpServer, McpServerInput, McpServerStatus, McpTransportKind } from '../../../shared/mcp'
import { OAUTH_REDIRECT_URL, joinCommand, splitCommand } from '../../../shared/mcp'
import type { ToolPolicy } from '../../../shared/toolMeta'

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  disabled: 'Disabled',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
  needs_auth: 'Sign-in required',
  authorizing: 'Waiting for sign-in…'
}
const TRANSPORT_LABEL: Record<McpTransportKind, string> = { stdio: 'Local command', http: 'Remote (HTTP)', sse: 'Remote (SSE)' }

/** Build an update from the renderer-safe view; secrets are untouched because envSet/headersSet are omitted. */
const toInput = (s: McpServer, patch: Partial<McpServerInput> = {}): McpServerInput => ({
  id: s.id, name: s.name, enabled: s.enabled, transport: s.transport, command: s.command, args: s.args, url: s.url,
  policy: s.policy, toolPolicies: s.toolPolicies, ...patch
})

const hostOf = (u?: string) => {
  try {
    return new URL(u ?? '').host
  } catch {
    return u ?? 'this server'
  }
}

const launchLine = (s: McpServer) => (s.transport === 'stdio' ? joinCommand(s.command ?? '', s.args) : s.url ?? '')

export function McpSettings() {
  const { settings, setSettings, mcpStatus, showToast } = useStore()
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!settings) return null
  const servers = settings.mcpServers
  const statusOf = (id: string) => mcpStatus.find((s) => s.id === id)

  const save = async (input: McpServerInput) => {
    try {
      setSettings(await window.api.mcp.save(input))
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const totalTools = servers.reduce((n, s) => n + (statusOf(s.id)?.state === 'connected' ? statusOf(s.id)!.tools.filter((t) => (s.toolPolicies[t.name] ?? s.policy) !== 'deny').length : 0), 0)

  if (editing) return <ServerForm server={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} onSave={save} />
  if (importing) return <ImportForm onDone={() => setImporting(false)} onSave={save} />

  return (
    <div className="form">
      <div className="mcp-intro">
        <p>
          <b>MCP servers</b> give the model extra tools (databases, GitHub, browsers…). Local servers are programs that run on your computer with your permissions — only add ones you trust.
          The master switch and permissions in the <i>Tools</i> tab also apply here.
        </p>
        <div className="form-actions">
          <button className="btn primary" onClick={() => setEditing('new')}>＋ Add server</button>
          <button className="btn" onClick={() => setImporting(true)}>Import JSON…</button>
        </div>
      </div>

      {totalTools > 40 && (
        <div className="status bad" role="status">
          {totalTools} MCP tools are active. Many models get worse at picking tools beyond ~40 — disable ones you don’t need.
        </div>
      )}

      {servers.length === 0 && <p className="muted">No servers yet. Add one, or paste a config from a server’s README with “Import JSON”.</p>}

      {servers.map((s) => {
        const st = statusOf(s.id)
        const state = st?.state ?? (s.enabled ? 'connecting' : 'disabled')
        return (
          <div key={s.id} className={`mcp-server mcp-${state}`}>
            <div className="mcp-head">
              <span className={`mcp-dot ${state}`} title={STATE_LABEL[state]} />
              <div className="mcp-title">
                <b>{s.name}</b>
                <span className="risk">{TRANSPORT_LABEL[s.transport]}</span>
                <span className="muted small">
                  {STATE_LABEL[state]}
                  {state === 'connected' && ` · ${st!.tools.length} tool${st!.tools.length === 1 ? '' : 's'}`}
                  {state === 'connected' && st?.serverInfo && ` · ${st.serverInfo}`}
                  {s.transport !== 'stdio' && st?.signedIn && state === 'connected' && ' · signed in'}
                </span>
              </div>
              <label className="check mcp-toggle" title="Enable / disable this server">
                <input type="checkbox" checked={s.enabled} onChange={(e) => save(toInput(s, { enabled: e.target.checked }))} /> On
              </label>
            </div>
            <code className="mcp-launch">{launchLine(s)}</code>
            {state === 'error' && (
              <div className="status bad">
                {st?.error}
                {st?.stderr && <pre className="mcp-stderr">{st.stderr}</pre>}
              </div>
            )}
            {state === 'needs_auth' && (
              <div className="tool-notice">
                {st?.error ?? 'This server requires you to sign in.'}{' '}
                <button className="btn primary signin" onClick={() => window.api.mcp.signIn(s.id)}>Sign in</button>
              </div>
            )}
            {state === 'authorizing' && (
              <div className="tool-notice">
                Finish signing in in your browser, then come back here. Only approve if you recognise <b>{hostOf(s.url)}</b>.{' '}
                <button className="btn" onClick={() => window.api.mcp.reopenAuth(s.id)}>Open sign-in page again</button>{' '}
                <button className="btn" onClick={() => window.api.mcp.cancelAuth(s.id)}>Cancel</button>
              </div>
            )}
            <div className="mcp-actions">
              {s.transport !== 'stdio' && st?.signedIn && (
                <button className="link-btn" onClick={() => confirm(`Sign out of “${s.name}”? Its stored sign-in will be deleted from this computer.`) && window.api.mcp.signOut(s.id)}>
                  Sign out
                </button>
              )}
              {state === 'connected' && st!.tools.length > 0 && (
                <button className="link-btn" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>
                  {open[s.id] ? 'Hide tools' : 'Show tools'}
                </button>
              )}
              {s.enabled && <button className="link-btn" onClick={() => window.api.mcp.restart(s.id)}>Restart</button>}
              <button className="link-btn" onClick={() => setEditing(s)}>Edit</button>
              <button
                className="link-btn danger-link"
                onClick={async () => confirm(`Remove “${s.name}”?`) && setSettings(await window.api.mcp.remove(s.id))}
              >
                Remove
              </button>
              <span className="spacer" />
              <label className="inline-select">
                Default permission
                <select value={s.policy} onChange={(e) => save(toInput(s, { policy: e.target.value as ToolPolicy }))}>
                  <option value="ask">Ask each time</option>
                  <option value="allow">Always allow</option>
                  <option value="deny">Disabled</option>
                </select>
              </label>
            </div>

            {open[s.id] && st && (
              <table className="perm mcp-tools">
                <tbody>
                  {st.tools.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <div>
                          <code>{t.name}</code> {t.readOnly && <span className="risk risk-read">read-only</span>}
                        </div>
                        {t.description && <div className="hint clamp">{t.description}</div>}
                      </td>
                      <td>
                        <select
                          value={s.toolPolicies[t.name] ?? ''}
                          onChange={(e) => {
                            const next = { ...s.toolPolicies }
                            if (e.target.value) next[t.name] = e.target.value as ToolPolicy
                            else delete next[t.name]
                            void save(toInput(s, { toolPolicies: next }))
                          }}
                        >
                          <option value="">Server default</option>
                          <option value="ask">Ask each time</option>
                          <option value="allow">Always allow</option>
                          <option value="deny">Disabled</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------- key/value rows for env vars & headers (values are write-only) ----------

interface Row { key: string; value: string; existing: boolean; removed: boolean }

function KVEditor({ title, hint, rows, setRows, keyPlaceholder }: { title: string; hint: string; rows: Row[]; setRows(r: Row[]): void; keyPlaceholder: string }) {
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="form-block">
      <b>{title}</b>
      {rows.map((r, i) =>
        r.removed ? null : (
          <div className="kv-row" key={i}>
            <input value={r.key} readOnly={r.existing} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} spellCheck={false} />
            <input
              type="password"
              value={r.value}
              autoComplete="off"
              placeholder={r.existing ? '•••••••• saved (blank = keep)' : 'value'}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <button className="icon-btn" aria-label={`Remove ${r.key || 'row'}`} onClick={() => (r.existing ? set(i, { removed: true }) : setRows(rows.filter((_, j) => j !== i)))}>✕</button>
          </div>
        )
      )}
      <button className="link-btn" onClick={() => setRows([...rows, { key: '', value: '', existing: false, removed: false }])}>＋ Add</button>
      <span className="hint">{hint}</span>
    </div>
  )
}

function rowsOf(keys: string[] = []): Row[] {
  return keys.map((key) => ({ key, value: '', existing: true, removed: false }))
}
function diffRows(rows: Row[]) {
  const set: Record<string, string> = {}
  const remove: string[] = []
  for (const r of rows) {
    const key = r.key.trim()
    if (r.removed) remove.push(r.key)
    else if (key && r.value !== '') set[key] = r.value
  }
  return { set, remove }
}

function ServerForm({ server, onDone, onSave }: { server?: McpServer; onDone(): void; onSave(i: McpServerInput): Promise<void> }) {
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<McpTransportKind>(server?.transport ?? 'stdio')
  const [cmd, setCmd] = useState(server ? joinCommand(server.command ?? '', server.args) : '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [policy, setPolicy] = useState<ToolPolicy>(server?.policy ?? 'ask')
  const [envRows, setEnvRows] = useState<Row[]>(rowsOf(server?.envKeys))
  const [hdrRows, setHdrRows] = useState<Row[]>(rowsOf(server?.headerKeys))
  const [oauthId, setOauthId] = useState(server?.oauth?.clientId ?? '')
  const [oauthSecret, setOauthSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [oauthScope, setOauthScope] = useState(server?.oauth?.scope ?? '')
  const [err, setErr] = useState('')

  const submit = async () => {
    const argv = splitCommand(cmd)
    if (transport === 'stdio' && !argv.length) return setErr('Enter the command that starts the server.')
    if (transport !== 'stdio') {
      try {
        const u = new URL(url)
        if (!/^https?:$/.test(u.protocol)) throw new Error()
      } catch {
        return setErr('Enter a valid http(s) URL.')
      }
    }
    const env = diffRows(envRows)
    const hdr = diffRows(hdrRows)
    await onSave({
      id: server?.id,
      name: name.trim() || (transport === 'stdio' ? argv.find((a) => !a.startsWith('-') && a !== 'npx' && a !== 'uvx') ?? 'server' : new URL(url).hostname),
      enabled, transport, policy, toolPolicies: server?.toolPolicies,
      ...(transport === 'stdio' ? { command: argv[0], args: argv.slice(1), envSet: env.set, envRemove: env.remove } : { url, headersSet: hdr.set, headersRemove: hdr.remove, oauth: { clientId: oauthId, clientSecret: clearSecret || !oauthId ? '' : oauthSecret || undefined, scope: oauthScope } })
    })
    onDone()
  }

  return (
    <div className="form">
      <div className="modal-head inline">
        <h3>{server ? `Edit ${server.name}` : 'Add MCP server'}</h3>
      </div>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub" />
        <span className="hint">Shown in tool names the model sees, so keep it short.</span>
      </label>
      <label>
        Type
        <select value={transport} onChange={(e) => setTransport(e.target.value as McpTransportKind)}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote server (Streamable HTTP)</option>
          <option value="sse">Remote server (legacy SSE)</option>
        </select>
      </label>
      {transport === 'stdio' ? (
        <>
          <label>
            Command
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/folder" spellCheck={false} />
            <span className="hint">The full command line. Runs on your computer, starting in your workspace folder (or home).</span>
          </label>
          <KVEditor title="Environment variables" hint="Stored encrypted when an OS keychain exists; never shown again." rows={envRows} setRows={setEnvRows} keyPlaceholder="API_KEY" />
        </>
      ) : (
        <>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
            <span className="hint">If the server needs you to sign in (OAuth), Talaria will show a <b>Sign in</b> button after you add it — no token to paste.</span>
          </label>
          <KVEditor title="Headers" hint="Only for servers that take a fixed API key/token, e.g. Authorization: Bearer … Stored encrypted when an OS keychain exists; never shown again." rows={hdrRows} setRows={setHdrRows} keyPlaceholder="Authorization" />
          <details className="oauth-adv" open={!!(server?.oauth?.clientId || server?.oauth?.scope)}>
            <summary>OAuth settings (advanced)</summary>
            <div className="form">
              <span className="hint">
                Most servers register Talaria automatically. Fill these in only if the server requires a pre-registered app, and register this redirect URI with it: <code>{OAUTH_REDIRECT_URL}</code>
              </span>
              <label>
                Client ID
                <input value={oauthId} onChange={(e) => setOauthId(e.target.value)} spellCheck={false} autoComplete="off" />
              </label>
              <label>
                Client secret <span className="muted small">(optional)</span>
                <input
                  type="password"
                  value={oauthSecret}
                  autoComplete="off"
                  onChange={(e) => { setOauthSecret(e.target.value); setClearSecret(false) }}
                  placeholder={server?.oauth?.hasClientSecret && !clearSecret ? '•••••••• saved (leave blank to keep)' : ''}
                />
                {server?.oauth?.hasClientSecret && (
                  <label className="check"><input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} /> Remove saved secret</label>
                )}
              </label>
              <label>
                Scope <span className="muted small">(optional)</span>
                <input value={oauthScope} onChange={(e) => setOauthScope(e.target.value)} placeholder="e.g. mcp:read" spellCheck={false} />
              </label>
            </div>
          </details>
        </>
      )}
      <label>
        Default permission for its tools
        <select value={policy} onChange={(e) => setPolicy(e.target.value as ToolPolicy)}>
          <option value="ask">Ask each time (recommended)</option>
          <option value="allow">Always allow</option>
          <option value="deny">Disabled</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled (connects now{transport === 'stdio' ? ' and starts the program' : ''})
      </label>
      {err && <div className="status bad">{err}</div>}
      <div className="form-actions">
        <button className="btn primary" onClick={submit}>{server ? 'Save' : 'Add server'}</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

function ImportForm({ onDone, onSave }: { onDone(): void; onSave(i: McpServerInput): Promise<void> }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<McpImportResult | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    for (const s of result!.servers) await onSave(s)
    setBusy(false)
    onDone()
  }

  return (
    <div className="form">
      <div className="modal-head inline"><h3>Import MCP servers</h3></div>
      <label>
        Paste a config
        <textarea
          rows={9}
          value={text}
          onChange={(e) => { setText(e.target.value); setResult(null) }}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}'}
          spellCheck={false}
          className="mono"
        />
        <span className="hint">The format used by Claude Desktop, Cursor and most server READMEs.</span>
      </label>
      {!result ? (
        <div className="form-actions">
          <button className="btn primary" disabled={!text.trim()} onClick={async () => setResult(await window.api.mcp.parseImport(text))}>Review</button>
          <button className="btn" onClick={onDone}>Cancel</button>
        </div>
      ) : (
        <>
          {result.errors.map((e, i) => <div key={i} className="status bad">{e}</div>)}
          {result.servers.length > 0 && (
            <div className="form-block">
              <b>{result.servers.length} server{result.servers.length === 1 ? '' : 's'} will be added</b>
              {result.servers.map((s) => (
                <div key={s.name} className="mcp-preview">
                  <b>{s.name}</b> <span className="risk">{TRANSPORT_LABEL[s.transport]}</span>
                  <code className="mcp-launch">{s.transport === 'stdio' ? joinCommand(s.command ?? '', s.args) : s.url}</code>
                  {(s.envSet || s.headersSet) && <span className="hint">+ {Object.keys({ ...s.envSet, ...s.headersSet }).length} secret value(s) (encrypted with your OS keychain when available)</span>}
                </div>
              ))}
              <span className="hint warn">Local servers will start immediately and run these commands on your computer. Check each one first.</span>
            </div>
          )}
          <div className="form-actions">
            <button className="btn primary" disabled={!result.servers.length || busy} onClick={add}>{busy ? 'Adding…' : 'Add & connect'}</button>
            <button className="btn" onClick={() => setResult(null)}>Back</button>
            <button className="btn" onClick={onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}
