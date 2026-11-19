import { parse, stringify } from 'yaml'

export class SkillParseError extends Error {}

export interface ParsedSkill {
  meta: Record<string, unknown>
  body: string
}

/** Split a SKILL.md into its YAML header and markdown body. Throws SkillParseError with a user-facing reason. */
export function parseSkillMd(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(src)
  if (!m) throw new SkillParseError('SKILL.md must start with a YAML header between "---" lines containing name and description.')
  if (m[1].length > 8192) throw new SkillParseError('The YAML header is too large.')
  let meta: unknown
  try {
    meta = parse(m[1], { maxAliasCount: 10 })
  } catch (e) {
    throw new SkillParseError(`The YAML header is invalid: ${(e as Error).message.split('\n')[0]}`)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new SkillParseError('The YAML header must be a set of "key: value" lines.')
  return { meta: meta as Record<string, unknown>, body: (m[2] ?? '').replace(/^\s*\n/, '').trimEnd() }
}

/** Build a SKILL.md; `extra` keeps unknown header keys (license, metadata, …) intact across edits. */
export function buildSkillMd(f: { name: string; description: string; body: string; extra?: Record<string, unknown> }): string {
  const { name: _n, description: _d, ...rest } = f.extra ?? {}
  const header = stringify({ name: f.name, description: f.description.trim(), ...rest }, { lineWidth: 0 })
  return `---\n${header}---\n\n${f.body.trim()}\n`
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
