// Skills: reusable instruction packages in the open SKILL.md format (folder + YAML header + markdown body).

/** user = you added it; model = the assistant created it (with your approval); workspace = found inside the project folder. */
export type SkillSource = 'user' | 'model' | 'workspace'

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  /** Will be offered to the model and available as /name. */
  enabled: boolean
  /** Workspace skills only: you reviewed and approved this exact content. */
  trusted: boolean
  /** Workspace skills only: approved earlier, but the file has changed since. */
  changed: boolean
  dir: string
  files: string[]
  bytes: number
  /** Why this skill can't be used (bad header, too large…). */
  invalid?: string
}

export interface SkillFull extends SkillSummary {
  /** Markdown instructions (without the header). */
  body: string
}

export interface SkillInput {
  name: string
  description: string
  body: string
  /** When renaming/editing an existing user skill. */
  originalName?: string
}

export interface SkillsSettings {
  /** Master switch: catalog, use_skill tool and /commands. */
  enabled: boolean
  /** User/model skills the user turned off. */
  disabled: string[]
  /** Workspace skills the user approved: name → content hash at approval time. */
  trusted: Record<string, string>
}

export const SKILL_NAME_MAX = 64
export const SKILL_DESC_MAX = 1024
export const SKILL_BODY_MAX = 50_000
export const SKILL_CATALOG_BUDGET = 4000

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Returns an error message, or null when valid. */
export function validateSkillFields(f: { name: string; description: string; body: string }): string | null {
  if (!f.name || f.name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(f.name)) {
    return `Name must be lowercase letters, digits and single hyphens (max ${SKILL_NAME_MAX}), e.g. "code-review".`
  }
  if (!f.description.trim()) return 'A description is required — it is how the model decides when to use the skill.'
  if (f.description.length > SKILL_DESC_MAX) return `Description is too long (max ${SKILL_DESC_MAX} characters).`
  if (!f.body.trim()) return 'The instructions are empty.'
  if (f.body.length > SKILL_BODY_MAX) return `Instructions are too long (max ${SKILL_BODY_MAX.toLocaleString()} characters).`
  return null
}

/** `/name rest of line` → { command, args }; null when it isn't a slash command. */
export function parseSlash(text: string): { command: string; args: string } | null {
  const m = /^\/([a-z0-9][a-z0-9-]*)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  return m ? { command: m[1], args: (m[2] ?? '').trim() } : null
}

/** The system-prompt section listing skills the model may load with use_skill. */
export function formatSkillCatalog(skills: { name: string; description: string }[], budget = SKILL_CATALOG_BUDGET): string {
  if (!skills.length) return ''
  const lines: string[] = []
  let used = 0
  for (const s of skills) {
    const d = s.description.replace(/\s+/g, ' ').trim()
    const line = `- ${s.name}: ${d.length > 300 ? `${d.slice(0, 299)}…` : d}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length + 1
  }
  const omitted = skills.length - lines.length
  return [
    '## Skills',
    "Skills are reusable instructions for specific kinds of task. When a request matches a skill's description, call use_skill with its name BEFORE starting, then follow the instructions it returns. Don't mention a skill unless you use it.",
    ...lines,
    ...(omitted > 0 ? [`(${omitted} more skill${omitted === 1 ? '' : 's'} not listed)`] : [])
  ].join('\n')
}

/** The text a user-invoked skill contributes to that turn. */
export function skillInvocation(name: string, instructions: string, args: string): string {
  return [
    `The user invoked the skill "${name}". Follow these instructions for this request:`,
    '<skill_instructions>',
    instructions.trim(),
    '</skill_instructions>',
    '',
    args || '(The user gave no additional input.)'
  ].join('\n')
}
