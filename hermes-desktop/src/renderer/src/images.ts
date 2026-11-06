import { useEffect, useState } from 'react'
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, RESIZE_ABOVE_BYTES } from '../../shared/attachments'
import type { Attachment } from '../../shared/types'

export class ImageError extends Error {}

/**
 * Read a picked/pasted/dropped image and shrink it if it's huge (long edge > 2048px or > 1.5 MB), so it
 * uploads fast and stays under the size limit. GIFs are never re-encoded (it would flatten the animation).
 */
export async function prepareImage(file: Blob, name: string): Promise<{ name: string; bytes: Uint8Array }> {
  const original = new Uint8Array(await file.arrayBuffer())
  const type = file.type
  const reencodable = type === 'image/png' || type === 'image/jpeg' || type === 'image/webp'
  let bytes = original
  if (reencodable) {
    try {
      const bmp = await createImageBitmap(file)
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height))
      if (scale < 1 || file.size > RESIZE_ABOVE_BYTES) {
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)))
        canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
        const out = await canvas.convertToBlob({ type, quality: 0.9 })
        const smaller = new Uint8Array(await out.arrayBuffer())
        // Keep whichever is smaller (re-encoding an already-optimised file can grow it).
        if (smaller.length < original.length || original.length > MAX_ATTACHMENT_BYTES) bytes = smaller
      }
      bmp.close()
    } catch {
      /* undecodable here — let the main process judge the original bytes */
    }
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ImageError(`“${name}” is too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB).`)
  return { name, bytes }
}

const cache = new Map<string, Promise<string | null>>()

/** Data URL for an attachment (cached per id for the life of the window). */
export function loadDataUrl(a: Attachment): Promise<string | null> {
  let p = cache.get(a.id)
  if (!p) {
    p = window.api.attachments.dataUrl(a)
    cache.set(a.id, p)
    void p.then((v) => v === null && cache.delete(a.id))
  }
  return p
}

export function useDataUrl(a: Attachment): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void loadDataUrl(a).then((v) => live && setUrl(v))
    return () => {
      live = false
    }
  }, [a.id])
  return url
}
