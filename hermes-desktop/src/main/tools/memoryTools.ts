import { MemoryError, MemoryStore } from '../memory'
import { ToolError, type ToolContext, type ToolImpl } from './types'

function svc(ctx: ToolContext) {
  if (!ctx.services) throw new ToolError('Memory is not available.')
  return ctx.services
}

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof MemoryError) throw new ToolError(e.message)
    throw e
  }
}

export const remember: ToolImpl = {
  name: 'remember',
  description:
    'Save one short, self-contained fact to long-term memory so it is available in future conversations: a user preference, a name, or a project convention. ' +
    'Do NOT save secrets (keys, passwords), one-off details, or things already listed in memory. Use scope "project" for facts that only apply to the current workspace folder.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The fact, written as a complete sentence (max 500 characters)' },
      scope: { type: 'string', enum: ['global', 'project'], description: 'global (default) = all chats; project = only while this workspace folder is active' }
    },
    required: ['text']
  },
  describe: (a) => `remember: ${String(a?.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`,
  // Refuse impossible/forbidden saves before bothering the user with an approval prompt.
  validate: async (a, ctx) => {
    await wrap(async () => void MemoryStore.validate(a?.text))
    if (a?.scope === 'project' && !ctx.workspace) throw new ToolError('No workspace folder is set, so there is no project to scope this to. Use scope "global".')
  },
  async run(a, ctx) {
    const s = svc(ctx)
    const { item, duplicate } = await wrap(() => s.memory.add(String(a?.text ?? ''), { source: 'model', workspace: a?.scope === 'project' ? ctx.workspace : undefined }))
    s.changed('memory')
    return `${duplicate ? 'Already remembered' : 'Remembered'} [${item.id}]: ${item.text}`
  }
}

export const forget: ToolImpl = {
  name: 'forget',
  description: 'Delete a note from memory by its id (shown in square brackets in the Memory section). Use it when a note is wrong, outdated, or the user asks you to forget something.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The note id, e.g. "a1b2c3"' } }, required: ['id'] },
  describe: (a) => `forget [${a?.id ?? ''}]`,
  validate: async (a, ctx) => {
    const items = await svc(ctx).memory.list()
    if (!items.some((i) => i.id === String(a?.id))) throw new ToolError(`No memory with id "${a?.id}". Ids are the values in square brackets in the Memory section.`)
  },
  preview: async (a, ctx) => (await svc(ctx).memory.list()).find((i) => i.id === String(a?.id))?.text,
  async run(a, ctx) {
    const s = svc(ctx)
    const gone = await wrap(() => s.memory.remove(String(a?.id)))
    s.changed('memory')
    return `Forgot [${gone.id}]: ${gone.text}`
  }
}
