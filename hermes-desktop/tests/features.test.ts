import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/main/memory'
import { SkillRegistry, withEnabled } from '../src/main/skills/registry'
import { activeTools, authorize, featureTools, getTool, ToolError, type ToolContext } from '../src/main/tools'
import { toWire } from '../src/main/chat'
import type { SkillsSettings } from '../src/shared/skills'
import type { Message, ToolSettings } from '../src/shared/types'

let root = ''
let ws = ''
let memory: MemoryStore
let skills: SkillRegistry
let skillCfg: SkillsSettings
let changed: ReturnType<typeof vi.fn>

const tcfg = (over: Partial<ToolSettings> = {}): ToolSettings => ({ enabled: true, workspace: ws, policies: {}, ...over })
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  workspace: ws, signal: new AbortController().signal,
  services: { memory, skills, skillsConfig: () => skillCfg, changed: changed as any }, ...over
})
const run = (name: string, args: unknown, c = ctx()) => getTool(name)!.run(args, c)
const putSkill = (base: string, folder: string, desc = 'Does a thing', body = 'Do the thing.', files: Record<string, string> = {}) => {
  const d = path.join(base, folder)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${desc}\n---\n\n${body}\n`)
  for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), c) }
  return d
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'feat-')))
  ws = path.join(root, 'proj'); mkdirSync(ws)
  memory = new MemoryStore(path.join(root, 'memory.json'))
  skills = new SkillRegistry(path.join(root, 'skills'))
  skillCfg = { enabled: true, disabled: [], trusted: {} }
  changed = vi.fn()
})

describe('feature gating', () => {
  const names = (f: Parameters<typeof featureTools>[0]) => featureTools(f).map((t) => t.name)
  it('offers only what is enabled and useful', () => {
    expect(names({ memory: true, skills: true, haveSkills: true })).toEqual(['remember', 'forget', 'use_skill', 'read_skill_file', 'create_skill'])
    expect(names({ memory: false, skills: true, haveSkills: false })).toEqual(['create_skill']) // nothing to load, but can still author
    expect(names({ memory: true, skills: false, haveSkills: true })).toEqual(['remember', 'forget'])
    expect(names({ memory: false, skills: false, haveSkills: false })).toEqual([])
  })
  it('activeTools merges them, honors the master switch and per-tool "Disabled"', () => {
    const f = { memory: true, skills: true, haveSkills: true }
    expect(activeTools(tcfg(), [], f).map((t) => t.name)).toEqual(expect.arrayContaining(['remember', 'use_skill', 'run_command']))
    expect(activeTools(tcfg({ enabled: false }), [], f)).toEqual([])
    expect(activeTools(tcfg({ policies: { remember: 'deny' } }), [], f).map((t) => t.name)).not.toContain('remember')
    expect(activeTools(tcfg({ workspace: '' }), [], f).map((t) => t.name)).toEqual(expect.arrayContaining(['remember', 'use_skill'])) // no workspace needed
    expect(activeTools(tcfg()).map((t) => t.name)).not.toContain('remember') // no features → not offered
  })
  it('default policies: writes ask, reads auto', async () => {
    const a = (n: string) => authorize(getTool(n)!, {}, tcfg(), ctx(), new Set())
    expect(await a('remember')).toBe('ask')
    expect(await a('forget')).toBe('ask')
    expect(await a('create_skill')).toBe('ask')
    expect(await a('use_skill')).toBe('allow')
    expect(await a('read_skill_file')).toBe('allow')
  })
})

describe('remember / forget', () => {
  it('saves, reports, and notifies the UI; duplicates are not stored twice', async () => {
    const r = await run('remember', { text: 'Prefers tabs over spaces' })
    expect(r).toMatch(/^Remembered \[[a-z0-9]{6}\]: Prefers tabs/)
    expect(changed).toHaveBeenCalledWith('memory')
    expect(await run('remember', { text: 'prefers TABS over spaces!' })).toMatch(/^Already remembered/)
    const list = await memory.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ source: 'model', enabled: true })
    expect(list[0].workspace).toBeUndefined()
  })
  it('project scope binds to the workspace; refuses without one', async () => {
    await run('remember', { text: 'Uses pnpm', scope: 'project' })
    expect((await memory.list())[0].workspace).toBe(ws)
    const noWs = ctx({ workspace: '' })
    await expect(getTool('remember')!.validate!({ text: 'x', scope: 'project' }, noWs)).rejects.toThrow(/No workspace/)
  })
  it('validate() rejects secrets/empty/oversized BEFORE any approval prompt', async () => {
    const v = (text: unknown) => getTool('remember')!.validate!({ text }, ctx())
    await expect(v('my password is hunter2hunter2')).rejects.toThrow(/credential|secret/i)
    await expect(v('sk-abcdefghijklmnopqrstuvwx')).rejects.toBeInstanceOf(ToolError)
    await expect(v('')).rejects.toThrow(/empty/)
    await expect(v('x'.repeat(600))).rejects.toThrow(/too long/)
    await expect(v('A normal preference')).resolves.toBeUndefined()
    expect(await memory.list()).toEqual([])
  })
  it('run() still enforces the rules (defence in depth) and maps errors to ToolError', async () => {
    await expect(run('remember', { text: 'password: abcdefghij' })).rejects.toBeInstanceOf(ToolError)
    expect(changed).not.toHaveBeenCalled()
  })
  it('forget: validates the id, previews the text for the approval card, deletes', async () => {
    const { item } = await memory.add('Old fact', { source: 'user' })
    const f = getTool('forget')!
    await expect(f.validate!({ id: 'nope' }, ctx())).rejects.toThrow(/No memory with id/)
    await expect(f.validate!({ id: item.id }, ctx())).resolves.toBeUndefined()
    expect(await f.preview!({ id: item.id }, ctx())).toBe('Old fact')
    expect(await run('forget', { id: item.id })).toBe(`Forgot [${item.id}]: Old fact`)
    expect(await memory.list()).toEqual([])
    expect(changed).toHaveBeenCalledWith('memory')
  })
  it('fails clearly without services', async () => {
    await expect(getTool('remember')!.run({ text: 'x' }, { workspace: ws, signal: new AbortController().signal })).rejects.toThrow(/not available/)
  })
})

describe('use_skill / read_skill_file', () => {
  it('returns instructions, folder and bundled files', async () => {
    putSkill(path.join(root, 'skills'), 'report', 'Weekly report', '1. Gather\n2. Write', { 'templates/t.md': '# T', 'scripts/go.sh': 'echo' })
    const out = await run('use_skill', { name: 'report' })
    expect(out).toContain('# Skill: report')
    expect(out).toContain(`Skill folder: ${path.join(root, 'skills', 'report')}`)
    expect(out).toContain('scripts/go.sh, templates/t.md')
    expect(out).toContain('1. Gather\n2. Write')
  })
  it('unknown/disabled/untrusted skills are not available; the error lists what is', async () => {
    putSkill(path.join(root, 'skills'), 'on')
    putSkill(path.join(root, 'skills'), 'off')
    putSkill(path.join(ws, '.talaria', 'skills'), 'wsskill')
    skillCfg = { ...skillCfg, disabled: ['off'] }
    await expect(run('use_skill', { name: 'missing' })).rejects.toThrow(/Available: on/)
    await expect(run('use_skill', { name: 'off' })).rejects.toThrow(/No enabled skill/)
    await expect(run('use_skill', { name: 'wsskill' })).rejects.toThrow(/No enabled skill/) // untrusted workspace skill
    const rec = (await skills.scan(ws)).find((s) => s.name === 'wsskill')!
    skillCfg = withEnabled(rec, true, skillCfg)
    expect(await run('use_skill', { name: 'wsskill' })).toContain('# Skill: wsskill')
    skillCfg = { ...skillCfg, enabled: false }
    await expect(run('use_skill', { name: 'on' })).rejects.toThrow(/No enabled skill/)
  })
  it('read_skill_file reads bundled files only — no traversal, absolute paths or symlink escapes', async () => {
    const dir = putSkill(path.join(root, 'skills'), 'doc', 'd', 'b', { 'ref/a.txt': 'bundled content' })
    writeFileSync(path.join(root, 'secret.txt'), 'top secret')
    symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'link.txt'))
    symlinkSync(root, path.join(dir, 'rootlink'))
    expect(await run('read_skill_file', { name: 'doc', path: 'ref/a.txt' })).toBe('bundled content')
    for (const p of ['../../secret.txt', path.join(root, 'secret.txt'), '/etc/passwd', 'link.txt', 'rootlink/secret.txt']) {
      await expect(run('read_skill_file', { name: 'doc', path: p }), p).rejects.toThrow(/outside/)
    }
    await expect(run('read_skill_file', { name: 'nope', path: 'x' })).rejects.toThrow(/No enabled skill/)
    await expect(run('read_skill_file', { name: 'doc', path: 'missing.txt' })).rejects.toThrow(/not found/)
  })
})

describe('create_skill', () => {
  it('validate() rejects bad input before any prompt; run() writes a model-tagged skill', async () => {
    const t = getTool('create_skill')!
    const good = { name: 'weekly-report', description: 'Use for weekly status reports', instructions: '1. Do it' }
    await expect(t.validate!({ ...good, name: 'Bad Name' }, ctx())).rejects.toThrow(/Name must/)
    await expect(t.validate!({ ...good, name: '../x' }, ctx())).rejects.toThrow(/Name must/)
    await expect(t.validate!({ ...good, description: '' }, ctx())).rejects.toThrow(/description/)
    await expect(t.validate!({ ...good, instructions: '' }, ctx())).rejects.toThrow(/empty/)
    await expect(t.validate!(good, ctx())).resolves.toBeUndefined()
    const out = await run('create_skill', good)
    expect(out).toContain('/weekly-report')
    expect(changed).toHaveBeenCalledWith('skills')
    const rec = (await skills.scan(ws)).find((s) => s.name === 'weekly-report')!
    expect(rec.source).toBe('model')
    expect(readFileSync(path.join(root, 'skills', 'weekly-report', 'SKILL.md'), 'utf8')).toContain('talaria-model')
    // it is immediately usable
    expect(await run('use_skill', { name: 'weekly-report' })).toContain('1. Do it')
  })
  it('will not overwrite without overwrite:true; cannot escape the skills dir', async () => {
    await run('create_skill', { name: 'a-skill', description: 'd', instructions: 'v1' })
    await expect(run('create_skill', { name: 'a-skill', description: 'd', instructions: 'v2' })).rejects.toThrow(/already exists/)
    await run('create_skill', { name: 'a-skill', description: 'd', instructions: 'v2', overwrite: true })
    expect(readFileSync(path.join(root, 'skills', 'a-skill', 'SKILL.md'), 'utf8')).toContain('v2')
    await expect(run('create_skill', { name: '../../evil', description: 'd', instructions: 'x' })).rejects.toThrow(/Name must/)
    expect(existsSync(path.join(root, 'evil'))).toBe(false)
  })
})

describe('toWire with skill invocations', () => {
  const base = (m: Partial<Message>): Message => ({ id: '1', role: 'user', content: 'hi', createdAt: 0, ...m }) as Message
  it('expands a /skill message with its snapshotted instructions and the user args', () => {
    const w = toWire([base({ content: '/review check src/a.ts', skill: { name: 'review', text: 'Skill folder: /x\n\nBe careful.' } })])
    expect(w).toHaveLength(1)
    expect(w[0].role).toBe('user')
    expect(w[0].content).toContain('invoked the skill "review"')
    expect(w[0].content).toContain('Be careful.')
    expect(String(w[0].content).endsWith('check src/a.ts')).toBe(true)
    expect(String(w[0].content)).not.toContain('/review')
  })
  it('handles an invocation with no args and leaves ordinary messages alone', () => {
    const w = toWire([base({ content: '/review', skill: { name: 'review', text: 'x' } }), base({ id: '2', content: '/not-a-skill hello' })])
    expect(w[0].content).toContain('no additional input')
    expect(w[1].content).toBe('/not-a-skill hello')
  })
  it('the snapshot, not the current file, is what the model sees (history stays reproducible)', () => {
    const msg = base({ content: '/s go', skill: { name: 's', text: 'ORIGINAL instructions' } })
    expect(String(toWire([msg])[0].content)).toContain('ORIGINAL instructions')
  })
})
