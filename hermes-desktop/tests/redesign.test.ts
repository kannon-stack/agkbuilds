import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, PRESETS, isHighContrast, resolveAppearance, sanitizeAppearance, titleBarOverlay, UI_FONT_STACKS } from '../src/shared/theme'
import { cleanUserName, greeting, initial, MAX_USER_NAME, STARTERS } from '../src/shared/greeting'

describe('glass appearance setting', () => {
  it('is on by default and the bundled modern font is the default', () => {
    expect(DEFAULT_APPEARANCE.glass).toBe(true)
    expect(DEFAULT_APPEARANCE.uiFont).toBe('modern')
    expect(UI_FONT_STACKS.modern.stack).toMatch(/^'Plus Jakarta Sans Variable'/)
  })
  it('accepts only booleans', () => {
    expect(sanitizeAppearance({ glass: false }, DEFAULT_APPEARANCE).glass).toBe(false)
    expect(sanitizeAppearance({ glass: 'no' as any }, DEFAULT_APPEARANCE).glass).toBe(true)
    expect(sanitizeAppearance({ glass: 1 as any }, { ...DEFAULT_APPEARANCE, glass: false }).glass).toBe(false)
  })
  it('settings saved before the redesign get glass on', () => {
    const { glass: _, ...old } = DEFAULT_APPEARANCE
    expect(sanitizeAppearance(old, DEFAULT_APPEARANCE).glass).toBe(true)
  })
  it('resolves glass off for high-contrast themes even when the setting is on', () => {
    const a = { ...DEFAULT_APPEARANCE, darkTheme: 'contrast-dark', lightTheme: 'contrast-light' }
    expect(resolveAppearance('dark', a, true).glass).toBe(false)
    expect(resolveAppearance('light', a, false).glass).toBe(false)
    expect(resolveAppearance('dark', DEFAULT_APPEARANCE, true).glass).toBe(true)
    expect(resolveAppearance('dark', { ...DEFAULT_APPEARANCE, glass: false }, true).glass).toBe(false)
  })
  it('only the two high-contrast presets count as high contrast', () => {
    expect(PRESETS.filter(isHighContrast).map((t) => t.id).sort()).toEqual(['contrast-dark', 'contrast-light'])
  })
})

describe('title bar overlay colours', () => {
  it('match the window background, with text-coloured symbols, for every preset', () => {
    for (const t of PRESETS) {
      expect(titleBarOverlay(t.colors)).toEqual({ color: t.colors.bg, symbolColor: t.colors.text })
    }
  })
})

describe('user name and greeting', () => {
  it('cleans the name: one line, trimmed, capped', () => {
    expect(cleanUserName('  Dylan  ')).toBe('Dylan')
    expect(cleanUserName('Dy\nlan\t B')).toBe('Dy lan B')
    expect(cleanUserName(42)).toBe('')
    expect(cleanUserName(undefined)).toBe('')
    expect(cleanUserName('x'.repeat(100))).toHaveLength(MAX_USER_NAME)
  })
  it('greets by time of day', () => {
    expect(greeting(6)).toBe('Good morning')
    expect(greeting(11)).toBe('Good morning')
    expect(greeting(12)).toBe('Good afternoon')
    expect(greeting(17, 'Dylan')).toBe('Good afternoon, Dylan')
    expect(greeting(18, 'Dylan')).toBe('Good evening, Dylan')
    expect(greeting(2)).toBe('Good evening')
    expect(greeting(9, '   ')).toBe('Good morning')
  })
  it('avatar initial is the first letter or digit, uppercased', () => {
    expect(initial('dylan')).toBe('D')
    expect(initial(' émile')).toBe('É')
    expect(initial('')).toBe('?')
    expect(initial('!!')).toBe('?')
  })
  it('starter prompts are distinct and never empty', () => {
    expect(new Set(STARTERS.map((s) => s.label)).size).toBe(STARTERS.length)
    for (const s of STARTERS) expect(s.prompt.trim().length).toBeGreaterThan(5)
  })
})
