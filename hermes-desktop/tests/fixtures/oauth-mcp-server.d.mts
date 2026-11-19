export interface OAuthMcpOptions {
  supportRegistration?: boolean
  preRegistered?: { client_id: string; client_secret?: string }[]
  denyAuthorize?: boolean
  authorizationEndpointOverride?: string
  accessTtlMs?: number
  port?: number
}
export function startOAuthMcpServer(opts?: OAuthMcpOptions): Promise<{
  url: string
  mcpUrl: string
  stats: { registrations: any[]; authorize: Record<string, string>[]; token: { grant_type: string; client_id?: string; has_secret: boolean; resource?: string }[]; mcp: number; mcpUnauthorized: number }
  expireAccessTokens(): void
  revokeRefreshTokens(): void
  approve(authorizeUrl: string): Promise<Response>
  close(): Promise<void>
}>
