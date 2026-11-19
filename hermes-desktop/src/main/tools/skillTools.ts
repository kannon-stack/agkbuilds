import { SKILL_NAME_RE, validateSkillFields } from '../../shared/skills'
import { SkillError, activeSkills, type SkillRecord } from '../skills/registry'
import { resolvePath } from './pathguard'
import { readFile } from './fsTools'
import { ToolError, clip, type ToolContext, type ToolImpl } from './types'

function svc(ctx: ToolContext) {
  if (!ctx.services) throw new ToolError('Skills are not available.')
  return ctx.services
}

async function usable(ctx: ToolContext): Promise<SkillRecord[]> {
  const s = svc(ctx)
  return activeSkills(await s.skills.scan(ctx.workspace), s.skillsConfig())
}

/** Instructions + where the skill's other files live. Shared by use_skill and /name invocation. */
export function skillPayload(rec: SkillRecord): string {
  const others = rec.files.filter((f) => f !== 'SKILL.md')
  return [
    `Skill folder: ${rec.dir}`,
    others.length ? `Bundled files (read with read_skill_file; run scripts with their full path): ${others.slice(0, 40).join(', ')}${others.length > 40 ? ', …' : ''}` : 'Bundled files: none',
    '',
    rec.body
  ].join('\n')
}

export const useSkill: ToolImpl = {
  name: 'use_skill',
  description: 'Load the full instructions of a skill from the Skills list. Call this BEFORE starting a task that matches the skill, then follow what it says.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name from the Skills list' } }, required: ['name'] },
  describe: (a) => `use_skill ${a?.name ?? ''}`,
  async run(a, ctx) {
    const list = await usable(ctx)
    const rec = list.find((r) => r.name === String(a?.name))
    if (!rec) throw new ToolError(`No enabled skill named "${a?.name}".${list.length ? ` Available: ${list.map((r) => r.name).join(', ')}` : ''}`)
    return clip(`# Skill: ${rec.name}\n${skillPayload(rec)}`)
  }
}

export const readSkillFile: ToolImpl = {
  name: 'read_skill_file',
  description: "Read a text file bundled inside an enabled skill's folder (path relative to the skill folder). Only files inside that folder can be read.",
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name' }, path: { type: 'string', description: 'File path relative to the skill folder' } },
    required: ['name', 'path']
  },
  describe: (a) => `read_skill_file ${a?.name ?? ''}/${a?.path ?? ''}`,
  async run(a, ctx) {
    const rec = (await usable(ctx)).find((r) => r.name === String(a?.name))
    if (!rec) throw new ToolError(`No enabled skill named "${a?.name}".`)
    const r = await resolvePath(rec.dir, a?.path)
    if (!r.inside) throw new ToolError(`Refused: "${a?.path}" is outside the "${rec.name}" skill folder.`)
    return readFile.run({ path: a.path }, { workspace: rec.dir, signal: ctx.signal })
  }
}

export const createSkill: ToolImpl = {
  name: 'create_skill',
  description:
    'Save a new reusable skill to the user’s skills folder, so it is offered in future conversations and as a /command. Only create one when the user asks, or after finishing a multi-step task they will clearly repeat. ' +
    'The description must say WHEN to use it (it is how skills are matched). Instructions should be concrete, numbered steps in Markdown.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'lowercase-with-hyphens, e.g. "weekly-report"' },
      description: { type: 'string', description: 'What it does and when to use it (max 1024 characters)' },
      instructions: { type: 'string', description: 'The skill body in Markdown' },
      overwrite: { type: 'boolean', description: 'Replace an existing skill of the same name (default false)' }
    },
    required: ['name', 'description', 'instructions']
  },
  describe: (a) => `create_skill ${a?.name ?? ''}`,
  validate: async (a) => {
    const err = validateSkillFields({ name: String(a?.name ?? ''), description: String(a?.description ?? ''), body: String(a?.instructions ?? '') })
    if (err) throw new ToolError(err)
  },
  async run(a, ctx) {
    const s = svc(ctx)
    try {
      const rec = await s.skills.save({ name: String(a.name), description: String(a.description), body: String(a.instructions) }, 'model', { overwrite: a.overwrite === true })
      s.changed('skills')
      return `Saved skill "${rec.name}" to ${rec.dir}. The user can invoke it with /${rec.name}.`
    } catch (e) {
      if (e instanceof SkillError) throw new ToolError(e.message)
      throw e
    }
  }
}

export { SKILL_NAME_RE }
