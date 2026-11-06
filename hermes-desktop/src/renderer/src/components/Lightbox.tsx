import { useEffect } from 'react'

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="lightbox" role="dialog" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" aria-label="Close image" onClick={onClose}>✕</button>
    </div>
  )
}
