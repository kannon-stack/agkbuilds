import { spawn } from 'node:child_process'
import { ToolError, type ToolImpl } from './types'

const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 300
const KEEP = 12_000 // chars kept from each end of long output

function killTree(pid: number | undefined) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'])
    else process.kill(-pid, 'SIGKILL') // whole process group (we spawn detached)
  } catch {
    /* already gone */
  }
}

export const runCommand: ToolImpl = {
  name: 'run_command',
  description:
    'Run a shell command with the workspace as the working directory and return its combined stdout/stderr and exit code. Use for builds, tests, git, etc. Commands are not interactive (no stdin).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line' },
      timeout_seconds: { type: 'integer', description: `Kill after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})` }
    },
    required: ['command']
  },
  describe: (a) => `$ ${String(a?.command ?? '').split('\n')[0].slice(0, 200)}`,
  run(a, ctx) {
    const command = a?.command
    if (typeof command !== 'string' || !command.trim()) throw new ToolError('Missing required argument: command')
    if (!ctx.workspace) throw new ToolError('No workspace folder is set.')
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.floor(Number(a.timeout_seconds) || DEFAULT_TIMEOUT_S)))

    return new Promise<string>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.workspace,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }
      })
      let out = ''
      let status: 'exit' | 'timeout' | 'cancelled' = 'exit'
      const onData = (d: Buffer) => {
        out += d.toString('utf8')
        if (out.length > 5_000_000) out = out.slice(-2_500_000) // hard memory cap
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)

      const timer = setTimeout(() => {
        status = 'timeout'
        killTree(child.pid)
      }, timeoutS * 1000)
      const onAbort = () => {
        status = 'cancelled'
        killTree(child.pid)
      }
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (code: number | null, err?: Error) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        let text = out
        if (text.length > KEEP * 2) text = `${text.slice(0, KEEP)}\n… [${text.length - KEEP * 2} characters omitted] …\n${text.slice(-KEEP)}`
        const head =
          err ? `Failed to start: ${err.message}`
          : status === 'timeout' ? `Timed out after ${timeoutS}s and was killed.`
          : status === 'cancelled' ? 'Cancelled by user.'
          : `Exit code ${code}.`
        resolve(`${head}${text.trim() ? `\n${text.trimEnd()}` : '\n(no output)'}`)
      }
      child.on('error', (e) => finish(null, e))
      child.on('close', (code) => finish(code))
    })
  }
}
