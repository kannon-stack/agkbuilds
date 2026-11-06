import { memo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as ReactElement<{ children?: ReactNode }>).props?.children)
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = (children as ReactElement<{ className?: string }> | undefined)?.props
  const lang = /language-([\w-]+)/.exec(code?.className ?? '')?.[1] ?? 'text'
  const copy = async () => {
    await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang}</span>
        <button onClick={copy} className="link-btn">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
