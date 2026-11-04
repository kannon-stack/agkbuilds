import { resolveAppearance, type Resolved, type ThemeBase, type ThemeColors } from '../../shared/theme'
import type { Settings } from '../../shared/types'

export interface ThemeOverride {
  base: ThemeBase
  colors: ThemeColors
}

export const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Write the resolved theme onto :root as CSS custom properties. */
export function applyAppearance(s: Pick<Settings, 'theme' | 'appearance'>, override?: ThemeOverride | null): Resolved {
  const r = resolveAppearance(s.theme, s.appearance, prefersDark(), override ?? undefined)
  const root = document.documentElement
  root.dataset.theme = r.base
  for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v)
  return r
}
