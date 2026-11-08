import { describe, expect, it } from 'vitest'
import {
  CSS_VAR, DEFAULT_APPEARANCE, DEFAULT_DARK, DEFAULT_LIGHT, FONT_SCALE_MAX, FONT_SCALE_MIN, MAX_CUSTOM_THEMES, PRESETS,
  bestInk, contrast, contrastChecks, exportTheme, luminance, normalizeHex, parseThemeFile, resolveAppearance, sanitizeAppearance,
  sanitizeFontFamily, UI_FONT_STACKS, MONO_STACK, type Appearance, type ColorKey, type CustomTheme
} from '../src/shared/theme'

const KEYS = Object.keys(CSS_VAR) as ColorKey[]
const custom = (over: Partial<CustomTheme> = {}): CustomTheme => ({
  id: 'custom-1', name: 'Mine', base: 'dark', custom: true, colors: { ...PRESETS[0].colors, accent: '#ff0066' }, ...over
})

describe('colour maths', () => {
  it('normalizes hex and rejects junk', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex(' #AaBbCc ')).toBe('#aabbcc')
    for (const bad of ['red', '#12', '#12345', '#gggggg', 'rgb(0,0,0)', '', null, 5, '#ff00ff00', 'url(x)']) expect(normalizeHex(bad)).toBeNull()
  })
  it('matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
    expect(contrast('#ffffff', '#ffffff')).toBe(1)
    expect(luminance('#000000')).toBe(0)
  })
  it('bestInk picks the readable ink', () => {
    expect(bestInk('#ffd60a')).toBe('#101010')
    expect(bestInk('#0033cc')).toBe('#ffffff')
    for (const c of ['#e2b65c', '#5aa2ff', '#c58bff', '#1d5fcf', '#8f5a0c', '#ff0000', '#00ff00', '#777777']) {
      expect(contrast(c, bestInk(c))).toBeGreaterThanOrEqual(4.5 - 0.6) // mid-greys can't always reach 4.5, but are always the better of the two
      expect(contrast(c, bestInk(c))).toBeGreaterThanOrEqual(Math.max(contrast(c, '#101010'), contrast(c, '#ffffff')) - 1e-9)
    }
  })
})

describe('built-in presets', () => {
  it('have unique ids, a dark and a light default, and complete valid colours', () => {
    const ids = PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(PRESETS.find((p) => p.id === DEFAULT_DARK)?.base).toBe('dark')
    expect(PRESETS.find((p) => p.id === DEFAULT_LIGHT)?.base).toBe('light')
    expect(PRESETS.filter((p) => p.base === 'dark').length).toBeGreaterThanOrEqual(3)
    expect(PRESETS.filter((p) => p.base === 'light').length).toBeGreaterThanOrEqual(3)
    for (const p of PRESETS) for (const k of KEYS) expect(normalizeHex(p.colors[k]), `${p.id}.${k}`).toBe(p.colors[k])
  })
  it.each(PRESETS.map((p) => [p.id, p] as const))('%s meets the readability checks', (_id, p) => {
    const failing = contrastChecks(p.colors).filter((c) => !c.ok)
    expect(failing, failing.map((f) => `${f.label}: ${f.ratio} < ${f.min}`).join('; ')).toEqual([])
    for (const k of ['hlKeyword', 'hlString', 'hlNumber', 'hlFn', 'hlType'] as const) expect(contrast(p.colors[k], p.colors.codeBg), k).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.colors.hlComment, p.colors.codeBg), 'comments').toBeGreaterThanOrEqual(3) // comments are intentionally dimmer
  })
  it('light presets are actually light and dark presets dark', () => {
    for (const p of PRESETS) expect(luminance(p.colors.bg) > 0.5).toBe(p.base === 'light')
  })
})

describe('resolveAppearance', () => {
  const a = DEFAULT_APPEARANCE
  it('follows the OS in system mode and honors explicit modes', () => {
    expect(resolveAppearance('system', a, true).base).toBe('dark')
    expect(resolveAppearance('system', a, false).base).toBe('light')
    expect(resolveAppearance('dark', a, false).base).toBe('dark')
    expect(resolveAppearance('light', a, true).base).toBe('light')
  })
  it('emits every colour variable plus font/shape/layout variables', () => {
    const { vars } = resolveAppearance('dark', a, true)
    for (const k of KEYS) expect(vars[CSS_VAR[k]]).toMatch(/^#[0-9a-f]{6}$/)
    for (const v of ['--font-ui', '--font-mono', '--font-scale', '--radius', '--radius-lg', '--thread-w', '--shadow']) expect(vars[v]).toBeTruthy()
  })
  it('uses the per-base theme slot and falls back to defaults when the theme is missing', () => {
    expect(resolveAppearance('dark', { ...a, darkTheme: 'midnight' }, false).theme.id).toBe('midnight')
    expect(resolveAppearance('dark', { ...a, darkTheme: 'nope' }, false).theme.id).toBe(DEFAULT_DARK)
    expect(resolveAppearance('dark', { ...a, darkTheme: 'sky' }, false).theme.id).toBe(DEFAULT_DARK) // light theme in a dark slot is ignored
  })
  it('resolves custom themes', () => {
    const r = resolveAppearance('dark', { ...a, darkTheme: 'custom-1', customThemes: [custom()] }, false)
    expect(r.colors.accent).toBe('#ff0066')
  })
  it('accent override replaces accent and recomputes readable ink; editor override wins over both', () => {
    const r = resolveAppearance('dark', { ...a, accent: '#ffd60a' }, false)
    expect(r.vars['--accent']).toBe('#ffd60a')
    expect(r.vars['--accent-ink']).toBe('#101010')
    const r2 = resolveAppearance('light', { ...a, accent: '#0033cc' }, false)
    expect(r2.vars['--accent-ink']).toBe('#ffffff')
    const o = resolveAppearance('light', { ...a, accent: '#0033cc' }, false, { base: 'dark', colors: PRESETS[0].colors })
    expect(o.base).toBe('dark')
    expect(o.vars['--accent']).toBe(PRESETS[0].colors.accent)
  })
  it('maps typography, radius and width settings; custom fonts keep a fallback stack', () => {
    const { vars } = resolveAppearance('dark', { ...a, uiFont: 'custom', uiFontCustom: 'Fira Sans', monoFont: 'custom', monoFontCustom: 'Fira Code', fontScale: 1.2, radius: 'sharp', chatWidth: 'full' }, false)
    expect(vars['--font-ui']).toMatch(/^Fira Sans, /)
    expect(vars['--font-ui']).toContain('sans-serif')
    expect(vars['--font-mono']).toMatch(/^Fira Code, .*monospace$/)
    expect(vars['--font-scale']).toBe('1.2')
    expect(vars['--radius']).toBe('4px')
    expect(vars['--thread-w']).toBe('100%')
  })
})

describe('sanitizeAppearance (untrusted input)', () => {
  const prev: Appearance = DEFAULT_APPEARANCE
  it('accepts valid patches', () => {
    const r = sanitizeAppearance({ darkTheme: 'forest', lightTheme: 'paper', accent: '#ABCDEF', fontScale: 1.1, radius: 'round', chatWidth: 'wide', uiFont: 'serif' }, prev)
    expect(r).toMatchObject({ darkTheme: 'forest', lightTheme: 'paper', accent: '#abcdef', fontScale: 1.1, radius: 'round', chatWidth: 'wide', uiFont: 'serif' })
  })
  it('rejects bad values and keeps the previous ones', () => {
    const r = sanitizeAppearance({ darkTheme: 'sky', lightTheme: 'forest', accent: 'red', radius: 'huge' as any, chatWidth: 'x' as any, uiFont: 'comic' as any }, { ...prev, accent: '#112233' })
    expect(r).toMatchObject({ darkTheme: DEFAULT_DARK, lightTheme: DEFAULT_LIGHT, accent: '#112233', radius: 'default', chatWidth: 'default', uiFont: 'modern' })
  })
  it('clamps the font scale and ignores non-numbers', () => {
    expect(sanitizeAppearance({ fontScale: 9 }, prev).fontScale).toBe(FONT_SCALE_MAX)
    expect(sanitizeAppearance({ fontScale: 0.1 }, prev).fontScale).toBe(FONT_SCALE_MIN)
    expect(sanitizeAppearance({ fontScale: NaN }, prev).fontScale).toBe(1)
    expect(sanitizeAppearance({ fontScale: '2' as any }, prev).fontScale).toBe(1)
  })
  it('null clears the accent override', () => {
    expect(sanitizeAppearance({ accent: null }, { ...prev, accent: '#112233' }).accent).toBeNull()
  })
  it('strips CSS-injection characters from font names; an empty custom font resolves to the default stack', () => {
    expect(sanitizeFontFamily('Inter; } body { background:url(x)')).not.toMatch(/[;{}()]/)
    expect(sanitizeFontFamily("Fira Sans, 'Helvetica Neue'")).toBe("Fira Sans, 'Helvetica Neue'")
    const a = sanitizeAppearance({ uiFont: 'custom', uiFontCustom: ';{}', monoFont: 'custom' }, prev)
    expect(a).toMatchObject({ uiFont: 'custom', uiFontCustom: '', monoFont: 'custom' }) // selecting "Custom…" must stick while typing
    const { vars } = resolveAppearance('dark', a, false)
    expect(vars['--font-ui']).toBe(UI_FONT_STACKS.system.stack) // no dangling ", fallback" list
    expect(vars['--font-mono']).toBe(MONO_STACK)
  })
  it('validates custom themes: ids, colours, name, base; rejects preset-id clashes and duplicates; caps the count', () => {
    const r = sanitizeAppearance({ customThemes: [
      custom({ id: 'ok-1', name: '  Nice\u0000  ' }),
      custom({ id: 'ok-1', name: 'dup' }),
      custom({ id: 'midnight' }),
      { id: 'bad id!', name: 'x', base: 'dark', custom: true, colors: PRESETS[0].colors },
      { ...custom({ id: 'ok-2' }), colors: { ...PRESETS[0].colors, bg: 'javascript:alert(1)', accent: '#12' } } as any,
      null as any
    ] }, prev)
    expect(r.customThemes.map((t) => t.id)).toEqual(['ok-1', 'ok-2'])
    expect(r.customThemes[0].name).toBe('Nice')
    expect(r.customThemes[1].colors.bg).toBe(PRESETS[0].colors.bg) // invalid → default
    const many = Array.from({ length: 80 }, (_, i) => custom({ id: `t${i}` }))
    expect(sanitizeAppearance({ customThemes: many }, prev).customThemes).toHaveLength(MAX_CUSTOM_THEMES)
  })
  it('deleting the active custom theme falls back instead of dangling', () => {
    const withTheme = sanitizeAppearance({ customThemes: [custom()], darkTheme: 'custom-1' }, prev)
    expect(withTheme.darkTheme).toBe('custom-1')
    expect(sanitizeAppearance({ customThemes: [] }, withTheme).darkTheme).toBe(DEFAULT_DARK)
  })
  it('a custom theme can only fill a slot of its own base', () => {
    const r = sanitizeAppearance({ customThemes: [custom({ base: 'light' })], darkTheme: 'custom-1', lightTheme: 'custom-1' }, prev)
    expect(r.darkTheme).toBe(DEFAULT_DARK)
    expect(r.lightTheme).toBe('custom-1')
  })
  it('survives garbage', () => {
    expect(sanitizeAppearance(undefined, prev)).toEqual(prev)
    expect(sanitizeAppearance('x' as any, prev)).toEqual(prev)
    expect(() => sanitizeAppearance({ customThemes: 'no' as any, uiFont: {} as any }, prev)).not.toThrow()
  })
})

describe('theme import / export', () => {
  it('round-trips', () => {
    const t = custom({ name: 'Round Trip' })
    expect(parseThemeFile(exportTheme(t))).toEqual({ name: 'Round Trip', base: 'dark', colors: t.colors })
  })
  it('fills missing colours from the matching default and ignores invalid ones', () => {
    const r = parseThemeFile(JSON.stringify({ talariaTheme: 1, name: 'Partial', base: 'light', colors: { bg: '#112233', text: 'nope', extra: '#fff' } }))
    if ('error' in r) throw new Error(r.error)
    expect(r.colors.bg).toBe('#112233')
    expect(r.colors.text).toBe(PRESETS.find((p) => p.id === DEFAULT_LIGHT)!.colors.text)
    expect(Object.keys(r.colors).sort()).toEqual([...KEYS].sort())
  })
  it('reports clear errors', () => {
    expect(parseThemeFile('nope')).toEqual({ error: 'That is not valid JSON.' })
    expect('error' in parseThemeFile('{"colors":{}}')).toBe(true)
    expect('error' in parseThemeFile('{"talariaTheme":1}')).toBe(true)
    expect('error' in parseThemeFile('null')).toBe(true)
  })
})
