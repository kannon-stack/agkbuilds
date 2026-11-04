import type { ToolPolicy } from '../../shared/toolMeta'

export interface ToolContext {
  /** Absolute workspace root ('' when none chosen). */
  workspace: string
  signal: AbortSignal
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
