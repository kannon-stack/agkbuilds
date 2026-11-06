import { clip, ToolError, type ToolImpl } from './types'

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff)))

/** Crude but dependency-free HTML → text. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const body = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  const text = decode(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
  return title ? `# ${decode(title).trim()}\n\n${text}` : text
}

export const webFetch: ToolImpl = {
  name: 'web_fetch',
  description: 'Fetch a web page or API URL (http/https, GET) and return its text content. HTML is converted to plain text.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full http(s) URL' } },
    required: ['url']
  },
  describe: (a) => `web_fetch ${a?.url ?? ''}`,
  async run(a, ctx) {
    let url: URL
    try {
      url = new URL(String(a?.url))
    } catch {
      throw new ToolError('Invalid URL.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('Only http(s) URLs are supported.')

    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), 20_000)
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Talaria/0.1 (desktop AI assistant)', Accept: 'text/html,application/json,text/plain,*/*;q=0.5' }
      })
      const type = res.headers.get('content-type') ?? ''
      if (/^(image|audio|video)\/|application\/(zip|octet-stream|pdf)/i.test(type)) {
        throw new ToolError(`Not text content (${type}).`)
      }
      // Read at most ~2 MB.
      const reader = res.body!.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (size < 2_000_000) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
      }
      reader.cancel().catch(() => {})
      const raw = Buffer.concat(chunks).toString('utf8')
      const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw
      return clip(`HTTP ${res.status} ${type}\n\n${text}`)
    } catch (e) {
      if (e instanceof ToolError) throw e
      if (ctx.signal.aborted) throw new ToolError('Cancelled by user.')
      if (ctl.signal.aborted) throw new ToolError('Request timed out after 20s.')
      throw new ToolError(`Request failed: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}
