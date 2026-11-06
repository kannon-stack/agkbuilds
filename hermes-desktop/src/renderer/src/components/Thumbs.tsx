import { useState } from 'react'
import type { Attachment } from '../../../shared/types'
import { useDataUrl } from '../images'
import { Lightbox } from './Lightbox'

function Thumb({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const url = useDataUrl(a)
  const [open, setOpen] = useState(false)
  return (
    <div className="thumb" data-testid="thumb">
      {url ? (
        <button className="thumb-img" onClick={() => setOpen(true)} aria-label={`View ${a.name}`} title={a.name}>
          <img src={url} alt={a.name} draggable={false} />
        </button>
      ) : (
        <div className="thumb-img missing" title={url === null ? 'This image file is no longer available' : a.name}>
          {url === null ? '⚠' : '…'}
        </div>
      )}
      {onRemove && (
        <button className="thumb-x" onClick={onRemove} aria-label={`Remove ${a.name}`} title="Remove">
          ✕
        </button>
      )}
      {open && url && <Lightbox src={url} alt={a.name} onClose={() => setOpen(false)} />}
    </div>
  )
}

export function Thumbs({ items, onRemove }: { items: Attachment[]; onRemove?: (id: string) => void }) {
  if (!items.length) return null
  return (
    <div className="thumbs">
      {items.map((a) => (
        <Thumb key={a.id} a={a} onRemove={onRemove && (() => onRemove(a.id))} />
      ))}
    </div>
  )
}
