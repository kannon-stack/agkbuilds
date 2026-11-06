// Native Anthropic (Claude) provider: shared constants, option validation, model gating. Pure.

export type ProviderKind = 'openai' | 'anthropic'

export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthropicOptions {
  /** '' = the model's own default. Sent as output_config.effort (older models reject it). */
  effort: Effort
  /** Ask for readable reasoning summaries (adaptive thinking, display: "summarized") and show them. */
  showThinking: boolean
  /** Top-level automatic prompt caching: repeated conversation prefixes are re-read at ~10 % of the price. */
  promptCaching: boolean
  /** Opt in to server-side refusal fallback on the models that support it (Claude API only). */
  refusalFallback: boolean
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export const DEFAULT_ANTHROPIC_OPTIONS: AnthropicOptions = {
  effort: '',
  showThinking: false,
  promptCaching: true,
  refusalFallback: true
}

export const EFFORT_LABELS: Record<Exclude<Effort, ''>, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

export function normalizeAnthropicOptions(raw: unknown): AnthropicOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AnthropicOptions>
  const effort = (['', 'low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === r.effort) ?? ''
  return {
    effort,
    showThinking: r.showThinking === true,
    promptCaching: r.promptCaching !== false,
    refusalFallback: r.refusalFallback !== false
  }
}

export const isOfficialAnthropicUrl = (baseUrl: string) => {
  try {
    return new URL(baseUrl || ANTHROPIC_BASE_URL).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/**
 * Server-side refusal fallback exists only on the Claude API (not on proxies / other clouds) and only for certain models:
 * Fable/Mythos 5.x, Opus 5.x and Sonnet 5.5. Haiku 5.5 has none (a fallback list there is a 400).
 */
export function fallbackEligible(model: string, baseUrl: string): boolean {
  return isOfficialAnthropicUrl(baseUrl) && /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/.test(model)
}

export interface RefusalInfo {
  category: string | null
  explanation?: string | null
}

export function refusalMessage(r: RefusalInfo): string {
  const why = r.explanation ? ` ${r.explanation}` : ''
  const cat = r.category ? ` (category: ${r.category})` : ''
  return `Claude declined to answer${cat}.${why} Try rephrasing your request.`
}

export interface UsageInfo {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}
