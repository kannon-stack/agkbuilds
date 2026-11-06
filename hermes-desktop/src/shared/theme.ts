// Theming core: tokens, built-in presets, resolution to CSS variables, validation, import/export.
// Pure and dependency-free so main, renderer and tests share it.

export type ThemeBase = 'dark' | 'light'

/** Every colour a theme controls. Keys map 1:1 to CSS variables (see CSS_VAR). */
export interface ThemeColors {
  bg: string
  bgSidebar: string
  surface: string
  surface2: string
  border: string
  text: string
  muted: string
  accent: string
  /** Text/icon colour used on top of `accent`. */
  accentInk: string
  danger: string
  ok: string
  codeBg: string
  hlKeyword: string
  hlString: string
  hlNumber: string
  hlComment: string
  hlFn: string
  hlType: string
}
export type ColorKey = keyof ThemeColors

export interface ThemeDef {
  id: string
  name: string
  base: ThemeBase
  colors: ThemeColors
}
export interface CustomTheme extends ThemeDef {
  custom: true
}

export const CSS_VAR: Record<ColorKey, string> = {
  bg: '--bg', bgSidebar: '--bg-sidebar', surface: '--surface', surface2: '--surface-2', border: '--border',
  text: '--text', muted: '--muted', accent: '--accent', accentInk: '--accent-ink', danger: '--danger', ok: '--ok',
  codeBg: '--code-bg', hlKeyword: '--hl-keyword', hlString: '--hl-string', hlNumber: '--hl-number',
  hlComment: '--hl-comment', hlFn: '--hl-fn', hlType: '--hl-type'
}

/** Editor groupings + labels. */
export const COLOR_GROUPS: { title: string; keys: { key: ColorKey; label: string }[] }[] = [
  { title: 'Surfaces', keys: [
    { key: 'bg', label: 'Background' }, { key: 'bgSidebar', label: 'Sidebar' }, { key: 'surface', label: 'Cards & inputs' },
    { key: 'surface2', label: 'Raised / hover' }, { key: 'border', label: 'Borders' }, { key: 'codeBg', label: 'Code blocks' }] },
  { title: 'Text', keys: [{ key: 'text', label: 'Text' }, { key: 'muted', label: 'Muted text' }] },
  { title: 'Accent & status', keys: [
    { key: 'accent', label: 'Accent' }, { key: 'accentInk', label: 'Text on accent' }, { key: 'danger', label: 'Error' }, { key: 'ok', label: 'Success' }] },
  { title: 'Syntax highlighting', keys: [
    { key: 'hlKeyword', label: 'Keywords' }, { key: 'hlString', label: 'Strings' }, { key: 'hlNumber', label: 'Numbers' },
    { key: 'hlComment', label: 'Comments' }, { key: 'hlFn', label: 'Functions' }, { key: 'hlType', label: 'Types' }] }
]

// ---------------------------------------------------------------- presets

const T = (id: string, name: string, base: ThemeBase, c: ThemeColors): ThemeDef => ({ id, name, base, colors: c })

export const PRESETS: ThemeDef[] = [
  T('talaria-dark', 'Talaria Dark', 'dark', {
    bg: '#0e1014', bgSidebar: '#12151b', surface: '#171b23', surface2: '#1e232d', border: '#2c3342', text: '#e7e9ee', muted: '#8a93a6',
    accent: '#e2b65c', accentInk: '#1a1405', danger: '#f06b6b', ok: '#5fcf9a', codeBg: '#0a0c10',
    hlKeyword: '#c792ea', hlString: '#9ece6a', hlNumber: '#ff9e64', hlComment: '#6b7690', hlFn: '#7aa2f7', hlType: '#e2b65c' }),
  T('midnight', 'Midnight', 'dark', {
    bg: '#0a0f1e', bgSidebar: '#0d1326', surface: '#121a30', surface2: '#1a2440', border: '#2b3a66', text: '#e6ecff', muted: '#93a3cc',
    accent: '#5aa2ff', accentInk: '#06101f', danger: '#ff7a85', ok: '#52d6a1', codeBg: '#070b17',
    hlKeyword: '#bb9af7', hlString: '#9ece6a', hlNumber: '#ff9e64', hlComment: '#6a7aa6', hlFn: '#7dcfff', hlType: '#e0af68' }),
  T('forest', 'Forest', 'dark', {
    bg: '#0d1411', bgSidebar: '#101a16', surface: '#15201b', surface2: '#1c2923', border: '#2f4339', text: '#e3ede7', muted: '#8ba597',
    accent: '#6fd3a0', accentInk: '#04140c', danger: '#f27c7c', ok: '#8fdc6b', codeBg: '#09100d',
    hlKeyword: '#c3a6ff', hlString: '#a6e3a1', hlNumber: '#f5a97f', hlComment: '#6a8878', hlFn: '#89dceb', hlType: '#e5c890' }),
  T('dusk', 'Dusk', 'dark', {
    bg: '#120f1a', bgSidebar: '#161223', surface: '#1c1730', surface2: '#251f3d', border: '#3a3260', text: '#ece8f7', muted: '#a095c0',
    accent: '#c58bff', accentInk: '#170825', danger: '#ff7d8f', ok: '#6fdcae', codeBg: '#0d0a14',
    hlKeyword: '#ff79c6', hlString: '#a6e3a1', hlNumber: '#ffb86c', hlComment: '#7d729e', hlFn: '#8be9fd', hlType: '#f1fa8c' }),
  T('graphite', 'Graphite', 'dark', {
    bg: '#121212', bgSidebar: '#171717', surface: '#1e1e1e', surface2: '#272727', border: '#3a3a3a', text: '#ececec', muted: '#9c9c9c',
    accent: '#8fb4ff', accentInk: '#07111f', danger: '#ff7b7b', ok: '#6fd69a', codeBg: '#0b0b0b',
    hlKeyword: '#c9a7ff', hlString: '#a5d684', hlNumber: '#f0a36e', hlComment: '#767676', hlFn: '#8fc1ff', hlType: '#e6c07b' }),
  T('contrast-dark', 'High Contrast Dark', 'dark', {
    bg: '#000000', bgSidebar: '#000000', surface: '#0b0b0b', surface2: '#1a1a1a', border: '#8a8a8a', text: '#ffffff', muted: '#c8c8c8',
    accent: '#ffd60a', accentInk: '#000000', danger: '#ff6b6b', ok: '#4cf0a1', codeBg: '#000000',
    hlKeyword: '#d7aaff', hlString: '#8dff8d', hlNumber: '#ffb454', hlComment: '#a8a8a8', hlFn: '#7fc4ff', hlType: '#ffd60a' }),

  T('talaria-light', 'Talaria Light', 'light', {
    bg: '#fbfaf8', bgSidebar: '#f2f0ec', surface: '#ffffff', surface2: '#f4f2ee', border: '#d9d4ca', text: '#1c1e24', muted: '#5f6673',
    accent: '#8f5a0c', accentInk: '#ffffff', danger: '#b83232', ok: '#176f49', codeBg: '#f6f4ef',
    hlKeyword: '#8250df', hlString: '#1a7f37', hlNumber: '#bc4c00', hlComment: '#6e7781', hlFn: '#0550ae', hlType: '#953800' }),
  T('paper', 'Paper', 'light', {
    bg: '#f7f1e3', bgSidebar: '#efe7d4', surface: '#fffaf0', surface2: '#f1e8d3', border: '#d3c5a8', text: '#2b2418', muted: '#675b44',
    accent: '#9a4a17', accentInk: '#ffffff', danger: '#b3342f', ok: '#2f6f2f', codeBg: '#f3ead6',
    hlKeyword: '#7a3e9d', hlString: '#3d6f1f', hlNumber: '#b04a00', hlComment: '#7d705a', hlFn: '#1f5fa8', hlType: '#8a5a00' }),
  T('sky', 'Sky', 'light', {
    bg: '#f6f9fd', bgSidebar: '#edf2f9', surface: '#ffffff', surface2: '#eaf0f8', border: '#cfd9e8', text: '#14202e', muted: '#52627a',
    accent: '#1d5fcf', accentInk: '#ffffff', danger: '#b8323e', ok: '#14755a', codeBg: '#eff4fa',
    hlKeyword: '#7c4dd8', hlString: '#1a7f37', hlNumber: '#b4460a', hlComment: '#6b7a90', hlFn: '#0b57b0', hlType: '#8a4b00' }),
  T('mint', 'Mint', 'light', {
    bg: '#f4faf6', bgSidebar: '#e9f3ec', surface: '#ffffff', surface2: '#e6f1ea', border: '#c5d9cb', text: '#13241a', muted: '#4f6858',
    accent: '#17714a', accentInk: '#ffffff', danger: '#b5382f', ok: '#17714a', codeBg: '#eef6f0',
    hlKeyword: '#7c4dd8', hlString: '#1a7f37', hlNumber: '#b4460a', hlComment: '#66786c', hlFn: '#0b57b0', hlType: '#8a4b00' }),
  T('contrast-light', 'High Contrast Light', 'light', {
    bg: '#ffffff', bgSidebar: '#ffffff', surface: '#ffffff', surface2: '#ececec', border: '#595959', text: '#000000', muted: '#3a3a3a',
    accent: '#0033cc', accentInk: '#ffffff', danger: '#a60000', ok: '#00662b', codeBg: '#f5f5f5',
    hlKeyword: '#6a1fb5', hlString: '#006620', hlNumber: '#9a3400', hlComment: '#505050', hlFn: '#003d99', hlType: '#7a4200' })
]

export const DEFAULT_DARK = 'talaria-dark'
export const DEFAULT_LIGHT = 'talaria-light'

// ---------------------------------------------------------------- colour maths

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** '#abc' / '#AABBCC' → '#aabbcc'; null when invalid. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!HEX.test(s)) return null
  const h = s.slice(1).toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Dark or white ink — whichever reads better on `bg`. */
export function bestInk(bg: string): string {
  return contrast(bg, '#101010') >= contrast(bg, '#ffffff') ? '#101010' : '#ffffff'
}

// ---------------------------------------------------------------- appearance settings

export type UiFontKey = 'system' | 'humanist' | 'serif' | 'rounded' | 'custom'
export type MonoFontKey = 'system' | 'custom'
export type RadiusKey = 'sharp' | 'default' | 'round'
export type WidthKey = 'narrow' | 'default' | 'wide' | 'full'

export interface Appearance {
  lightTheme: string
  darkTheme: string
  /** '#rrggbb' accent override applied on top of any theme, or null for the theme's own. */
  accent: string | null
  uiFont: UiFontKey
  uiFontCustom: string
  monoFont: MonoFontKey
  monoFontCustom: string
  /** Multiplier on the base 14.5px text size. */
  fontScale: number
  radius: RadiusKey
  chatWidth: WidthKey
  customThemes: CustomTheme[]
}

export const DEFAULT_APPEARANCE: Appearance = {
  lightTheme: DEFAULT_LIGHT, darkTheme: DEFAULT_DARK, accent: null,
  uiFont: 'system', uiFontCustom: '', monoFont: 'system', monoFontCustom: '',
  fontScale: 1, radius: 'default', chatWidth: 'default', customThemes: []
}

export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.35
export const MAX_CUSTOM_THEMES = 30

export const UI_FONT_STACKS: Record<Exclude<UiFontKey, 'custom'>, { label: string; stack: string }> = {
  system: { label: 'System default', stack: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  humanist: { label: 'Humanist', stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif" },
  serif: { label: 'Serif', stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, Cambria, 'Times New Roman', serif" },
  rounded: { label: 'Rounded', stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Nunito, 'Segoe UI', sans-serif" }
}
export const MONO_STACK = "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

export const RADIUS: Record<RadiusKey, { label: string; r: string; lg: string }> = {
  sharp: { label: 'Sharp', r: '4px', lg: '6px' },
  default: { label: 'Default', r: '10px', lg: '16px' },
  round: { label: 'Round', r: '14px', lg: '24px' }
}
export const CHAT_WIDTH: Record<WidthKey, { label: string; w: string }> = {
  narrow: { label: 'Narrow', w: '640px' },
  default: { label: 'Default', w: '780px' },
  wide: { label: 'Wide', w: '980px' },
  full: { label: 'Full', w: '100%' }
}

/** Allow only characters that can appear in a font-family list. Returns '' when nothing usable remains. */
export function sanitizeFontFamily(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[^\w\s,'"\-.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(v)

/** Validate a user-supplied colour set; missing/invalid keys fall back to `fallback`. */
export function sanitizeColors(raw: unknown, fallback: ThemeColors): ThemeColors {
  const out = { ...fallback }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(fallback) as ColorKey[]) {
      const n = normalizeHex((raw as Record<string, unknown>)[k])
      if (n) out[k] = n
    }
  }
  return out
}

export function sanitizeCustomTheme(raw: any): CustomTheme | null {
  if (!raw || typeof raw !== 'object' || !isId(raw.id)) return null
  const base: ThemeBase = raw.base === 'light' ? 'light' : 'dark'
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : ''
  const fb = PRESETS.find((p) => p.id === (base === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT))!.colors
  return { id: raw.id, name: name || 'Custom theme', base, custom: true, colors: sanitizeColors(raw.colors, fb) }
}

export function allThemes(a: Pick<Appearance, 'customThemes'>): ThemeDef[] {
  return [...PRESETS, ...a.customThemes]
}

/** Merge a (possibly hostile/old) patch into the current appearance, validating every field. */
export function sanitizeAppearance(patch: Partial<Appearance> | undefined, prev: Appearance): Appearance {
  const out: Appearance = { ...prev }
  if (!patch || typeof patch !== 'object') return out
  if (Array.isArray(patch.customThemes)) {
    const seen = new Set<string>()
    out.customThemes = patch.customThemes
      .map(sanitizeCustomTheme)
      .filter((t): t is CustomTheme => !!t && !PRESETS.some((p) => p.id === t.id) && !seen.has(t.id) && !!seen.add(t.id))
      .slice(0, MAX_CUSTOM_THEMES)
  }
  const themes = allThemes(out)
  if (isId(patch.darkTheme) && themes.some((t) => t.id === patch.darkTheme && t.base === 'dark')) out.darkTheme = patch.darkTheme
  if (isId(patch.lightTheme) && themes.some((t) => t.id === patch.lightTheme && t.base === 'light')) out.lightTheme = patch.lightTheme
  // A deleted custom theme must not leave a dangling reference.
  if (!themes.some((t) => t.id === out.darkTheme && t.base === 'dark')) out.darkTheme = DEFAULT_DARK
  if (!themes.some((t) => t.id === out.lightTheme && t.base === 'light')) out.lightTheme = DEFAULT_LIGHT
  if (patch.accent === null) out.accent = null
  else if (patch.accent !== undefined) out.accent = normalizeHex(patch.accent) ?? out.accent
  if (patch.uiFont && (patch.uiFont === 'custom' || patch.uiFont in UI_FONT_STACKS)) out.uiFont = patch.uiFont
  if (patch.uiFontCustom !== undefined) out.uiFontCustom = sanitizeFontFamily(patch.uiFontCustom)
  if (patch.monoFont === 'system' || patch.monoFont === 'custom') out.monoFont = patch.monoFont
  if (patch.monoFontCustom !== undefined) out.monoFontCustom = sanitizeFontFamily(patch.monoFontCustom)
  if (typeof patch.fontScale === 'number' && isFinite(patch.fontScale)) out.fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(patch.fontScale * 100) / 100))
  if (patch.radius && patch.radius in RADIUS) out.radius = patch.radius
  if (patch.chatWidth && patch.chatWidth in CHAT_WIDTH) out.chatWidth = patch.chatWidth
  return out
}

// ---------------------------------------------------------------- resolution

export type Mode = 'system' | 'dark' | 'light'

export interface Resolved {
  base: ThemeBase
  theme: ThemeDef
  colors: ThemeColors
  /** CSS custom properties to set on :root. */
  vars: Record<string, string>
}

/**
 * Turn settings into concrete CSS variables.
 * `override` lets the theme editor preview unsaved colours live.
 */
export function resolveAppearance(mode: Mode, a: Appearance, prefersDark: boolean, override?: { base: ThemeBase; colors: ThemeColors }): Resolved {
  const base: ThemeBase = override ? override.base : mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode
  const themes = allThemes(a)
  const wanted = base === 'dark' ? a.darkTheme : a.lightTheme
  const theme = themes.find((t) => t.id === wanted && t.base === base) ?? PRESETS.find((p) => p.id === (base === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT))!
  const colors: ThemeColors = { ...(override ? override.colors : theme.colors) }
  if (a.accent && !override) {
    colors.accent = a.accent
    colors.accentInk = bestInk(a.accent)
  }

  const vars: Record<string, string> = {}
  for (const k of Object.keys(CSS_VAR) as ColorKey[]) vars[CSS_VAR[k]] = colors[k]
  vars['--shadow'] = base === 'dark' ? '0 10px 40px rgba(0, 0, 0, 0.45)' : '0 10px 40px rgba(40, 30, 10, 0.15)'
  // "Custom" with no name yet (just selected, still typing) behaves like the default.
  vars['--font-ui'] = a.uiFont === 'custom' && a.uiFontCustom ? `${a.uiFontCustom}, ${UI_FONT_STACKS.system.stack}` : UI_FONT_STACKS[a.uiFont === 'custom' ? 'system' : a.uiFont].stack
  vars['--font-mono'] = a.monoFont === 'custom' && a.monoFontCustom ? `${a.monoFontCustom}, ${MONO_STACK}` : MONO_STACK
  vars['--font-scale'] = String(a.fontScale)
  vars['--radius'] = RADIUS[a.radius].r
  vars['--radius-lg'] = RADIUS[a.radius].lg
  vars['--thread-w'] = CHAT_WIDTH[a.chatWidth].w
  return { base, theme, colors, vars }
}

// ---------------------------------------------------------------- import / export

export interface ThemeFile {
  talariaTheme: 1
  name: string
  base: ThemeBase
  colors: ThemeColors
}

export const exportTheme = (t: ThemeDef): string =>
  JSON.stringify({ talariaTheme: 1, name: t.name, base: t.base, colors: t.colors } satisfies ThemeFile, null, 2)

/** Parse a shared theme. Unknown/invalid colours fall back to the matching default theme; returns an error string on failure. */
export function parseThemeFile(text: string): { name: string; base: ThemeBase; colors: ThemeColors } | { error: string } {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return { error: 'That is not valid JSON.' }
  }
  if (!j || typeof j !== 'object' || j.talariaTheme !== 1) return { error: 'This does not look like a Talaria theme file ("talariaTheme": 1 is missing).' }
  if (!j.colors || typeof j.colors !== 'object') return { error: 'The theme has no "colors".' }
  const base: ThemeBase = j.base === 'light' ? 'light' : 'dark'
  const fb = PRESETS.find((p) => p.id === (base === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT))!.colors
  const name = typeof j.name === 'string' ? j.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : ''
  return { name: name || 'Imported theme', base, colors: sanitizeColors(j.colors, fb) }
}

/** Readability checks shown in the editor and enforced on presets by tests. */
export interface ContrastCheck { label: string; ratio: number; min: number; ok: boolean }
export function contrastChecks(c: ThemeColors): ContrastCheck[] {
  const mk = (label: string, fg: string, bg: string, min: number): ContrastCheck => {
    const ratio = Math.round(contrast(fg, bg) * 100) / 100
    return { label, ratio, min, ok: ratio >= min }
  }
  return [
    mk('Text on background', c.text, c.bg, 7),
    mk('Text on cards', c.text, c.surface, 7),
    mk('Muted text on background', c.muted, c.bg, 4.5),
    mk('Muted text on sidebar', c.muted, c.bgSidebar, 4.5),
    mk('Muted text on raised', c.muted, c.surface2, 4.5),
    mk('Accent as text/links on background', c.accent, c.bg, 4.5),
    mk('Text on accent buttons', c.accentInk, c.accent, 4.5),
    mk('Error text on background', c.danger, c.bg, 4.5),
    mk('Success text on background', c.ok, c.bg, 4.5),
    mk('Code text on code background', c.text, c.codeBg, 7),
    mk('Borders visible', c.border, c.bg, 1.3)
  ]
}
