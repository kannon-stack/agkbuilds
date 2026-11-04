// Test MCP server. `node mcp-server.mjs` = stdio. `node mcp-server.mjs --http <port>` = Streamable HTTP (stateless).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'node:http'

function build() {
  const server = new McpServer({ name: 'fixture', version: '1.2.3' })
  const text = (t) => ({ content: [{ type: 'text', text: t }] })

  server.registerTool('echo', { description: 'Echo back the message', inputSchema: { message: z.string() }, annotations: { readOnlyHint: true } },
    async ({ message }) => text(`echo: ${message}`))
  server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => text(String(a + b)))
  server.registerTool('fail', { description: 'Always reports a tool error', inputSchema: {} },
    async () => ({ isError: true, content: [{ type: 'text', text: 'something went wrong' }] }))
  server.registerTool('image', { description: 'Returns an image', inputSchema: {} },
    async () => ({ content: [{ type: 'image', data: Buffer.from('fakepng').toString('base64'), mimeType: 'image/png' }] }))
  server.registerTool('slow', { description: 'Sleeps until cancelled or 30s', inputSchema: {} },
    async (_a, extra) => { await new Promise((r) => { const t = setTimeout(r, 30000); extra.signal.addEventListener('abort', () => { clearTimeout(t); r() }) }); return text('done') })
  server.registerTool('env', { description: 'Read an env var of the server process', inputSchema: { name: z.string() } },
    async ({ name }) => text(`${name}=${process.env[name] ?? '(unset)'}`))
  server.registerTool('header', { description: 'Read a request header (HTTP only)', inputSchema: { name: z.string() } },
    async ({ name }, extra) => text(`${name}=${extra.requestInfo?.headers?.[name.toLowerCase()] ?? '(none)'}`))
  server.registerTool('add_tool', { description: 'Registers a new tool at runtime (list_changed)', inputSchema: {} }, async () => {
    server.registerTool('dynamic', { description: 'Added at runtime', inputSchema: {} }, async () => text('dynamic!'))
    return text('added')
  })
  server.registerTool('weird name!', { description: 'Name needs sanitizing', inputSchema: {} }, async () => text('ok'))
  return server
}

const i = process.argv.indexOf('--http')
if (i === -1) {
  await build().connect(new StdioServerTransport())
} else {
  const port = Number(process.argv[i + 1])
  http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    let raw = ''
    for await (const c of req) raw += c
    const server = build()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, JSON.parse(raw))
  }).listen(port, '127.0.0.1', () => console.error(`http fixture on ${port}`))
}
