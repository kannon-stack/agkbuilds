import { decryptSecret } from '../store'
import { McpManager } from './manager'

/** The one MCP connection manager for the app. */
export const mcp = new McpManager({ decrypt: decryptSecret })
