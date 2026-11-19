import type { ToolCall, ToolStatus } from '../../../shared/types'
import { metaFor } from '../../../shared/toolMeta'
import { useStore } from '../store'

const STATUS: Record<ToolStatus, { icon: string; label: string }> = {
  awaiting_approval: { icon: '⏸', label: 'Needs your approval' },
  running: { icon: '◌', label: 'Running' },
  done: { icon: '✓', label: 'Done' },
  error: { icon: '✕', label: 'Failed' },
  denied: { icon: '⊘', label: 'Denied' }
}

const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t)

function parse(args: string): Record<string, any> | null {
  try {
    const v = JSON.parse(args)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** What exactly is about to happen — shown before the user approves. */
function Preview({ call }: { call: ToolCall }) {
  const a = parse(call.arguments)
  if (!a) return <pre className="tool-pre">{clipText(call.arguments, 2000)}</pre>
  switch (call.name) {
    case 'run_command':
      return (
        <>
          <div className="tool-label">Command (runs in your workspace)</div>
          <pre className="tool-pre cmd">{String(a.command ?? '')}</pre>
        </>
      )
    case 'write_file':
      return (
        <>
          <div className="tool-label">Write to <code>{String(a.path)}</code></div>
          <pre className="tool-pre">{clipText(String(a.content ?? ''), 3000)}</pre>
        </>
      )
    case 'edit_file':
      return (
        <>
          <div className="tool-label">Edit <code>{String(a.path)}</code></div>
          <pre className="tool-pre del">{clipText(String(a.old_string ?? ''), 1500)}</pre>
          <pre className="tool-pre add">{clipText(String(a.new_string ?? ''), 1500)}</pre>
        </>
      )
    case 'remember':
      return (
        <>
          <div className="tool-label">Save to memory ({a.scope === 'project' ? 'this project only' : 'all chats'})</div>
          <pre className="tool-pre">{String(a.text ?? '')}</pre>
        </>
      )
    case 'forget':
      return (
        <>
          <div className="tool-label">Delete this memory note</div>
          <pre className="tool-pre del">{call.detail ?? `[${String(a.id)}]`}</pre>
        </>
      )
    case 'create_skill':
      return (
        <>
          <div className="tool-label">New skill <code>{String(a.name)}</code>{a.overwrite ? ' (replaces the existing one)' : ''}</div>
          <pre className="tool-pre">{clipText(String(a.description ?? ''), 600)}</pre>
          <div className="tool-label">Instructions</div>
          <pre className="tool-pre">{clipText(String(a.instructions ?? ''), 3000)}</pre>
        </>
      )
    case 'web_fetch':
      return (
        <>
          <div className="tool-label">Fetch URL</div>
          <pre className="tool-pre">{String(a.url)}</pre>
        </>
      )
    default:
      return (
        <>
          <div className="tool-label">Arguments</div>
          <pre className="tool-pre">{JSON.stringify(a, null, 2)}</pre>
        </>
      )
  }
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const decide = useStore((s) => s.decide)
  const st = STATUS[call.status]
  const meta = metaFor(call.name)
  const awaiting = call.status === 'awaiting_approval'

  return (
    <details className={`tool tool-${call.status}`} open={awaiting}>
      <summary>
        <span className={`tool-icon ${call.status === 'running' ? 'spin' : ''}`} aria-hidden>
          {st.icon}
        </span>
        <span className="tool-name">{call.label ?? meta?.label ?? call.name}</span>
        <span className="tool-sum">{call.summary ?? call.name}</span>
        <span className="tool-status">{st.label}</span>
      </summary>
      <div className="tool-body">
        <Preview call={call} />
        {awaiting && (call.name === 'remember' || call.name === 'create_skill') && (
          <div className="tool-notice">
            {call.name === 'remember'
              ? 'Memory persists across chats and is shown to the model every time. Approve only notes you want kept.'
              : 'Saved to your skills folder: it will be offered to the model in every future chat and as a /command.'}
          </div>
        )}
        {awaiting && call.external && (
          <div className="tool-notice">
            External MCP tool: it runs inside its server process with that server's own permissions, not Talaria's workspace limits.
          </div>
        )}
        {awaiting && (
          <div className="tool-approve" role="group" aria-label="Approve tool call">
            <button className="btn primary" onClick={() => decide(call.id, 'allow')}>
              Allow once
            </button>
            <button className="btn" onClick={() => decide(call.id, 'allow_chat')} title="Don't ask again for this tool in this chat (until you restart the app)">
              Allow for this chat
            </button>
            <button className="btn danger" onClick={() => decide(call.id, 'deny')}>
              Deny
            </button>
          </div>
        )}
        {call.result !== undefined && (
          <>
            <div className="tool-label">Result</div>
            <pre className={`tool-pre ${call.status === 'error' ? 'err' : ''}`}>{clipText(call.result, 4000)}</pre>
          </>
        )}
      </div>
    </details>
  )
}
