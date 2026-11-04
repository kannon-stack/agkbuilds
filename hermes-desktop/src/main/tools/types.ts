import type { ToolPolicy } from '../../shared/toolMeta'
import type { SkillsSettings } from '../../shared/skills'
import type { MemoryStore } from '../memory'
import type { SkillRegistry } from '../skills/registry'

/** App-level services for tools that need more than the filesystem (memory, skills). */
export interface ToolServices {
  memory: MemoryStore
  skills: SkillRegistry
  skillsConfig(): SkillsSettings
  /** Tell the UI that memory/skills changed behind its back. */
  changed(kind: 'memory' | 'skills'): void
}

export interface ToolContext {
  /** Absolute workspace root ('' when none chosen). */
  workspace: string
  signal: AbortSignal
  services?: ToolServices
}

export interface ToolImpl {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Display name for UI (defaults to the static label for built-ins). */
  label?: string
  /** Policy when the user hasn't overridden it (MCP tools carry their server's policy). */
  defaultPolicy?: ToolPolicy
  /** Provided by an external MCP server rather than built in. */
  external?: boolean
  /** Short one-liner for the UI. */
  describe(args: any): string
  /** Reject impossible/forbidden calls up front (throw ToolError) — before the user is asked. */
  validate?(args: any, ctx: ToolContext): Promise<void>
  /** Extra human-readable context for the approval card. */
  preview?(args: any, ctx: ToolContext): Promise<string | undefined>
  /** True when this particular call touches something outside the safe zone and must ask. */
  forceAsk?(args: any, ctx: ToolContext): Promise<boolean>
  run(args: any, ctx: ToolContext): Promise<string>
}

/** Thrown for problems the model should see (bad args, not found…), not crashes. */
export class ToolError extends Error {}

export const MAX_OUTPUT_CHARS = 30_000

export function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… [truncated, ${text.length - max} more characters]`
}
