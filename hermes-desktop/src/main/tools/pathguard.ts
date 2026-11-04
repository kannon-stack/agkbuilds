import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ToolError } from './types'

/** realpath of the nearest existing ancestor + the not-yet-existing remainder. */
async function realpathLoose(abs: string): Promise<string> {
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      return path.join(real, ...rest.reverse())
    } catch (e) {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

export interface Resolved {
  abs: string
  /** Fully resolved (symlinks followed) path lies within the workspace. */
  inside: boolean
}

/** Resolve a model-supplied path against the workspace; symlink escapes count as outside. */
export async function resolvePath(workspace: string, p: unknown): Promise<Resolved> {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('Missing required argument: path')
  const base = workspace || process.cwd()
  const abs = path.resolve(base, p)
  if (!workspace) return { abs, inside: false }
  const [real, wsReal] = await Promise.all([realpathLoose(abs), realpathLoose(path.resolve(workspace))])
  const rel = path.relative(wsReal, real)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  return { abs, inside }
}

export async function requireInside(workspace: string, p: unknown): Promise<string> {
  const r = await resolvePath(workspace, p)
  if (!r.inside) throw new ToolError(`Refused: "${String(p)}" is outside the workspace. Writes are only allowed inside ${workspace || '(no workspace set)'}.`)
  return r.abs
}
