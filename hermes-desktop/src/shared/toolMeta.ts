// Tool metadata shared by main (execution/policy) and renderer (settings UI, cards).

export type ToolRisk = 'read' | 'write' | 'exec' | 'network'
export type ToolPolicy = 'ask' | 'allow' | 'deny'

export interface ToolMeta {
  name: string
  label: string
  risk: ToolRisk
  description: string
  /** Needs a workspace folder to be usable. */
  needsWorkspace: boolean
  defaultPolicy: ToolPolicy
}

export const TOOL_META: ToolMeta[] = [
  { name: 'read_file', label: 'Read files', risk: 'read', needsWorkspace: true, defaultPolicy: 'allow',
    description: 'Read text files. Inside the workspace this runs automatically; outside it always asks.' },
  { name: 'list_dir', label: 'List folders', risk: 'read', needsWorkspace: true, defaultPolicy: 'allow',
    description: 'List directory contents. Inside the workspace this runs automatically; outside it always asks.' },
  { name: 'write_file', label: 'Write files', risk: 'write', needsWorkspace: true, defaultPolicy: 'ask',
    description: 'Create or overwrite files inside the workspace.' },
  { name: 'edit_file', label: 'Edit files', risk: 'write', needsWorkspace: true, defaultPolicy: 'ask',
    description: 'Replace an exact snippet in an existing file inside the workspace.' },
  { name: 'run_command', label: 'Run shell commands', risk: 'exec', needsWorkspace: true, defaultPolicy: 'ask',
    description: 'Run a shell command in the workspace. Not sandboxed: it can do anything you can.' },
  { name: 'web_fetch', label: 'Fetch web pages', risk: 'network', needsWorkspace: false, defaultPolicy: 'ask',
    description: 'Download a URL (http/https) and return its text.' }
]

export const metaFor = (name: string) => TOOL_META.find((t) => t.name === name)

export const MAX_TOOL_STEPS = 20
