import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SKILL_BODY_MAX, SKILL_NAME_RE, validateSkillFields,
  type SkillInput, type SkillSource, type SkillSummary, type SkillsSettings
} from '../../shared/skills'
import { buildSkillMd, parseSkillMd, SkillParseError, str } from './parse'

/** A problem the user/model should be told about (bad skill, collision…), not a crash. */
export class SkillError extends Error {}

const MAX_SKILL_MD = 200_000
const MAX_FILES = 200
const MAX_DEPTH = 6
const MAX_IMPORT_BYTES = 5_000_000
const IGNORED = new Set(['node_modules', '.git', '.DS_Store', '__pycache__'])
const CREATED_BY = 'talaria-model'

export interface SkillRecord {
  name: string
  description: string
  source: SkillSource
  dir: string
  body: string
  /** Unknown header keys preserved across edits. */
  extra: Record<string, unknown>
  files: string[]
  bytes: number
  /** Content fingerprint used for workspace-skill trust. */
  hash: string
  invalid?: string
}

interface Listing {
  files: string[]
  bytes: number
}

/** Recursively list regular files (never following symlinks), bounded in count and depth. */
async function listFiles(dir: string, root = dir, depth = 0, out: Listing = { files: [], bytes: 0 }): Promise<Listing> {
  if (depth > MAX_DEPTH || out.files.length >= MAX_FILES) return out
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.isSymbolicLink()) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await listFiles(p, root, depth + 1, out)
    else if (e.isFile() && out.files.length < MAX_FILES) {
      const st = await fs.stat(p)
      out.files.push(path.relative(root, p).split(path.sep).join('/'))
      out.bytes += st.size
    }
  }
  return out
}

async function readSkill(dir: string, source: SkillSource, folder: string): Promise<SkillRecord> {
  const base: SkillRecord = { name: folder, description: '', source, dir, body: '', extra: {}, files: [], bytes: 0, hash: '' }
  const skillFile = path.join(dir, 'SKILL.md')
  try {
    const st = await fs.stat(skillFile)
    if (st.size > MAX_SKILL_MD) return { ...base, invalid: `SKILL.md is too large (${Math.round(st.size / 1000)} KB, max ${MAX_SKILL_MD / 1000} KB).` }
    const raw = await fs.readFile(skillFile, 'utf8')
    const listing = await listFiles(dir)
    const files = ['SKILL.md', ...listing.files.filter((f) => f !== 'SKILL.md')] // the entry point first
    const bytes = listing.bytes
    const hash = createHash('sha256').update(raw).update('\0').update(files.join('\n')).digest('hex').slice(0, 24)
    const rec = { ...base, files, bytes, hash }
    const { meta, body } = parseSkillMd(raw)
    const name = str(meta.name).trim() || folder
    const description = str(meta.description).replace(/\s+/g, ' ').trim()
    const { name: _n, description: _d, ...extra } = meta
    const effectiveSource: SkillSource = source === 'user' && (extra.metadata as any)?.created_by === CREATED_BY ? 'model' : source
    const err = validateSkillFields({ name, description, body })
    return { ...rec, name, description, body, extra, source: effectiveSource, ...(err ? { invalid: err } : {}) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, invalid: 'No SKILL.md in this folder.' }
    return { ...base, invalid: e instanceof SkillParseError ? e.message : `Could not read SKILL.md: ${(e as Error).message}` }
  }
}

export class SkillRegistry {
  constructor(public userDir: string) {}

  /** Workspace folders searched for skills, in priority order. */
  static workspaceDirs(workspace: string): string[] {
    return workspace ? [path.join(workspace, '.talaria', 'skills'), path.join(workspace, '.claude', 'skills')] : []
  }

  /**
   * Every skill found, de-duplicated by name (yours/the model's beat the workspace's; invalid ones are kept
   * so the UI can explain what is wrong).
   */
  async scan(workspace: string): Promise<SkillRecord[]> {
    const found: SkillRecord[] = []
    const roots: [string, SkillSource, boolean][] = [[this.userDir, 'user', true], ...SkillRegistry.workspaceDirs(workspace).map((d): [string, SkillSource, boolean] => [d, 'workspace', false])]
    for (const [root, source, allowLinks] of roots) {
      let entries
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.')) continue
        // Untrusted (workspace) folders must not be able to point us elsewhere via symlinks.
        if (e.isSymbolicLink() && !allowLinks) continue
        const dir = path.join(root, e.name)
        const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(dir).then((s) => s.isDirectory(), () => false)))
        if (!isDir) continue
        found.push(await readSkill(dir, source, e.name))
      }
    }
    const seen = new Set<string>()
    return found.filter((s) => {
      const key = s.name
      if (!s.invalid) {
        if (seen.has(key)) return false
        seen.add(key)
      }
      return true
    })
  }

  async save(input: SkillInput, source: 'user' | 'model', opts: { overwrite: boolean }): Promise<SkillRecord> {
    const err = validateSkillFields(input)
    if (err) throw new SkillError(err)
    const target = path.join(this.userDir, input.name)
    const from = input.originalName && input.originalName !== input.name ? path.join(this.userDir, input.originalName) : target
    const exists = await fs.stat(target).then(() => true, () => false)
    if (from !== target) {
      if (exists) throw new SkillError(`A skill named "${input.name}" already exists.`)
      if (!(await fs.stat(from).then(() => true, () => false))) throw new SkillError(`The skill "${input.originalName}" no longer exists.`)
    } else if (exists && !opts.overwrite) {
      throw new SkillError(`A skill named "${input.name}" already exists. Pass overwrite: true to replace it.`)
    }

    // Keep unknown header keys and bundled files when editing an existing skill.
    let extra: Record<string, unknown> = {}
    if (await fs.stat(from).then(() => true, () => false)) extra = (await readSkill(from, 'user', path.basename(from))).extra
    else if (source === 'model') extra = { metadata: { created_by: CREATED_BY } }
    if (source === 'model' && !(extra.metadata as any)?.created_by) extra = { ...extra, metadata: { ...(extra.metadata as object), created_by: CREATED_BY } }

    await fs.mkdir(this.userDir, { recursive: true })
    if (from !== target) await fs.rename(from, target)
    await fs.mkdir(target, { recursive: true })
    const file = path.join(target, 'SKILL.md')
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, buildSkillMd({ ...input, extra }), 'utf8')
    await fs.rename(tmp, file)
    return readSkill(target, 'user', input.name)
  }

  async remove(name: string): Promise<void> {
    if (!SKILL_NAME_RE.test(name)) throw new SkillError('Invalid skill name.')
    const dir = path.join(this.userDir, name)
    if (!(await fs.stat(dir).then(() => true, () => false))) throw new SkillError(`No skill named "${name}" in your skills folder.`)
    await fs.rm(dir, { recursive: true, force: true })
  }

  /** Copy a skill folder (must contain SKILL.md) into the user skills dir, refusing symlinks and oversized trees. */
  async importFolder(src: string): Promise<SkillRecord> {
    const rec = await readSkill(src, 'user', path.basename(src))
    if (rec.invalid) throw new SkillError(`That folder is not a valid skill: ${rec.invalid}`)
    if (rec.bytes > MAX_IMPORT_BYTES) throw new SkillError(`That skill is too large to import (${Math.round(rec.bytes / 1e6)} MB, max ${MAX_IMPORT_BYTES / 1e6} MB).`)
    const dest = path.join(this.userDir, rec.name)
    if (await fs.stat(dest).then(() => true, () => false)) throw new SkillError(`A skill named "${rec.name}" already exists.`)
    const tmp = `${dest}.importing-${process.pid}`
    await fs.rm(tmp, { recursive: true, force: true })
    try {
      for (const rel of rec.files) {
        const from = path.join(src, ...rel.split('/'))
        const to = path.join(tmp, ...rel.split('/'))
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.copyFile(from, to)
      }
      await fs.rename(tmp, dest)
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true })
      throw e
    }
    return readSkill(dest, 'user', rec.name)
  }
}

// ---------------------------------------------------------------- state → what is usable

export function summarize(rec: SkillRecord, cfg: SkillsSettings): SkillSummary {
  const ws = rec.source === 'workspace'
  const approved = cfg.trusted[rec.name]
  const trusted = ws ? !!approved && approved === rec.hash : true
  const changed = ws && !!approved && approved !== rec.hash
  const off = cfg.disabled.includes(rec.name)
  return {
    name: rec.name, description: rec.description, source: rec.source, dir: rec.dir, files: rec.files, bytes: rec.bytes, invalid: rec.invalid,
    trusted, changed, enabled: !rec.invalid && trusted && (ws ? true : !off)
  }
}

/** Skills the model may load / the user may invoke right now. */
export function activeSkills(records: SkillRecord[], cfg: SkillsSettings): SkillRecord[] {
  if (!cfg.enabled) return []
  return records.filter((r) => summarize(r, cfg).enabled)
}

/** Apply an enable/disable request, returning the new settings. Workspace skills are approved by content hash. */
export function withEnabled(rec: SkillRecord, enabled: boolean, cfg: SkillsSettings): SkillsSettings {
  const disabled = cfg.disabled.filter((n) => n !== rec.name)
  const trusted = { ...cfg.trusted }
  if (rec.source === 'workspace') {
    if (enabled) trusted[rec.name] = rec.hash
    else delete trusted[rec.name]
  } else if (!enabled) disabled.push(rec.name)
  return { ...cfg, disabled, trusted }
}

export { SKILL_BODY_MAX }
