import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolvePath, requireInside } from './pathguard'
import { clip, ToolError, type ToolImpl } from './types'

const MAX_READ_BYTES = 1_000_000

const outsideWorkspace = (p: unknown) => async (_a: any, ctx: { workspace: string }) =>
  !(await resolvePath(ctx.workspace, p)).inside

export const readFile: ToolImpl = {
  name: 'read_file',
  description:
    'Read a text file. Path is relative to the workspace root (or absolute). Optionally pass offset (1-based start line) and limit (max lines).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      offset: { type: 'integer', description: '1-based line to start at' },
      limit: { type: 'integer', description: 'Maximum number of lines to return' }
    },
    required: ['path']
  },
  describe: (a) => `read_file ${a?.path ?? ''}`,
  forceAsk: (a, ctx) => outsideWorkspace(a?.path)(a, ctx),
  async run(a, ctx) {
    const { abs } = await resolvePath(ctx.workspace, a?.path)
    let st
    try {
      st = await fs.stat(abs)
    } catch {
      throw new ToolError(`File not found: ${a.path}`)
    }
    if (st.isDirectory()) throw new ToolError(`${a.path} is a directory; use list_dir.`)
    const fh = await fs.open(abs, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES))
      await fh.read(buf, 0, buf.length, 0)
    } finally {
      await fh.close()
    }
    if (buf.includes(0)) throw new ToolError(`${a.path} looks like a binary file; not returning it.`)
    let lines = buf.toString('utf8').split('\n')
    const start = Math.max(1, Math.floor(Number(a.offset) || 1))
    const limit = a.limit ? Math.max(1, Math.floor(Number(a.limit))) : undefined
    const total = lines.length
    lines = lines.slice(start - 1, limit ? start - 1 + limit : undefined)
    let out = lines.join('\n')
    if (st.size > MAX_READ_BYTES && !limit) out += `\n… [file is ${st.size} bytes; only the first ${MAX_READ_BYTES} were read]`
    if (start > 1 || limit) out = `[lines ${start}-${start + lines.length - 1} of ${total}]\n` + out
    return clip(out)
  }
}

export const listDir: ToolImpl = {
  name: 'list_dir',
  description: 'List the entries of a directory (directories end with "/"). Path is relative to the workspace root; use "." for the root.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path', default: '.' } }
  },
  describe: (a) => `list_dir ${a?.path ?? '.'}`,
  forceAsk: (a, ctx) => outsideWorkspace(a?.path ?? '.')(a, ctx),
  async run(a, ctx) {
    const { abs } = await resolvePath(ctx.workspace, a?.path ?? '.')
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      throw new ToolError(`Cannot list ${a?.path ?? '.'}: not a directory or not found.`)
    }
    // Resolve symlinks so linked directories are listed (and sorted) as directories.
    const items = await Promise.all(
      entries.slice(0, 2000).map(async (e) => {
        let dir = e.isDirectory()
        if (e.isSymbolicLink()) dir = await fs.stat(path.join(abs, e.name)).then((s) => s.isDirectory(), () => false)
        return { name: e.name, dir }
      })
    )
    items.sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name))
    const shown = items.slice(0, 500).map((e) => (e.dir ? `${e.name}/` : e.name))
    return shown.join('\n') + (items.length > 500 ? `\n… [${items.length - 500}+ more entries]` : '') || '(empty directory)'
  }
}

export const writeFile: ToolImpl = {
  name: 'write_file',
  description: 'Create a file or completely overwrite an existing one, inside the workspace. Parent folders are created. Prefer edit_file for small changes.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full file contents' } },
    required: ['path', 'content']
  },
  validate: async (a, ctx) => void (await requireInside(ctx.workspace, a?.path)),
  describe: (a) => `write_file ${a?.path ?? ''} (${typeof a?.content === 'string' ? Buffer.byteLength(a.content) : 0} bytes)`,
  async run(a, ctx) {
    if (typeof a?.content !== 'string') throw new ToolError('Missing required argument: content')
    const abs = await requireInside(ctx.workspace, a.path)
    let existed = true
    try {
      if ((await fs.stat(abs)).isDirectory()) throw new ToolError(`${a.path} is a directory.`)
    } catch (e) {
      if (e instanceof ToolError) throw e
      existed = false
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, a.content, 'utf8')
    return `${existed ? 'Overwrote' : 'Created'} ${a.path} (${Buffer.byteLength(a.content)} bytes).`
  }
}

export const editFile: ToolImpl = {
  name: 'edit_file',
  description: 'Replace one exact snippet in an existing file inside the workspace. old_string must match exactly once (include enough context to be unique).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace (must occur exactly once)' },
      new_string: { type: 'string', description: 'Replacement text' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  validate: async (a, ctx) => void (await requireInside(ctx.workspace, a?.path)),
  describe: (a) => `edit_file ${a?.path ?? ''}`,
  async run(a, ctx) {
    if (typeof a?.old_string !== 'string' || typeof a?.new_string !== 'string') {
      throw new ToolError('old_string and new_string are required strings.')
    }
    if (!a.old_string) throw new ToolError('old_string must not be empty (use write_file to create files).')
    const abs = await requireInside(ctx.workspace, a.path)
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      throw new ToolError(`File not found: ${a.path}`)
    }
    const count = text.split(a.old_string).length - 1
    if (count === 0) throw new ToolError('old_string was not found in the file. Re-read the file and copy the text exactly.')
    if (count > 1) throw new ToolError(`old_string matches ${count} places; add more surrounding context so it is unique.`)
    await fs.writeFile(abs, text.replace(a.old_string, () => a.new_string), 'utf8')
    return `Edited ${a.path}.`
  }
}
