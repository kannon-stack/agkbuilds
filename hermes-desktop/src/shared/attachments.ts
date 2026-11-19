// Image attachments: limits and file-type sniffing shared by main and renderer.
import type { Attachment } from './types'

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 6
/** Renderer downscales anything bigger than this (longest edge) before saving. */
export const MAX_IMAGE_EDGE = 2048
export const RESIZE_ABOVE_BYTES = 1.5 * 1024 * 1024

export type ImageMime = Attachment['mime']
export const IMAGE_MIMES: readonly ImageMime[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const IMAGE_EXT: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const ATTACHMENT_ID = /^[0-9a-f]{64}$/

/** Base64 image data by attachment id, loaded by the main process for the messages being sent. */
export type ImageLookup = ReadonlyMap<string, string>

/** Text appended for an image whose file has gone missing, so the model knows something was there. */
export const missingImageNote = (name: string) => `[image unavailable: ${name}]`

/** Identify an image by its first bytes — never trust the file name or a claimed MIME type. */
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x)
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/** A display name that is safe to show/store (no paths, no control chars, bounded). */
export function cleanName(name: string, mime: ImageMime): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const t = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  return t || `image.${IMAGE_EXT[mime]}`
}
