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
  { name: 'remember', label: 'Remember things', risk: 'write', needsWorkspace: false, defaultPolicy: 'ask',
    description: 'Save a short note to memory so it is available in future chats. Asking first stops a malicious page from planting persistent instructions.' },
  { name: 'forget', label: 'Forget memories', risk: 'write', needsWorkspace: false, defaultPolicy: 'ask',
    description: 'Delete a saved memory note.' },
  { name: 'use_skill', label: 'Use skills', risk: 'read', needsWorkspace: false, defaultPolicy: 'allow',
    description: 'Load the full instructions of an enabled skill when a task matches it.' },
  { name: 'read_skill_file', label: 'Read skill files', risk: 'read', needsWorkspace: false, defaultPolicy: 'allow',
    description: "Read a file bundled inside an enabled skill's folder (confined to that folder)." },
  { name: 'create_skill', label: 'Create skills', risk: 'write', needsWorkspace: false, defaultPolicy: 'ask',
    description: 'Save a new reusable skill to your skills folder.' },
  { name: 'web_fetch', label: 'Fetch web pages', risk: 'network', needsWorkspace: false, defaultPolicy: 'ask',
    description: 'Download a URL (http/https) and return its text.' }
]

export const metaFor = (name: string) => TOOL_META.find((t) => t.name === name)

export const MAX_TOOL_STEPS = 20
