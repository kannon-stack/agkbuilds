/** New-chat screen: the greeting, the user's name and the starter prompts. */

export const MAX_USER_NAME = 40

/** Validate the "What should Talaria call you?" setting: one line, trimmed, at most 40 characters. */
export function cleanUserName(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_USER_NAME).trim()
}

/** "Good morning" (5–11), "Good afternoon" (12–17), "Good evening" (otherwise), plus the name when set. */
export function greeting(hour: number, name = ''): string {
  const part = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening'
  const n = cleanUserName(name)
  return n ? `${part}, ${n}` : part
}

/** First letter for the avatar ("?" when no name is set). */
export const initial = (name: string): string => (cleanUserName(name).match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase()

export interface Starter {
  /** Short label on the chip. */
  label: string
  icon: 'file' | 'code' | 'pencil' | 'calendar' | 'bulb'
  /** Text put into the composer (never sent automatically). */
  prompt: string
}

export const STARTERS: Starter[] = [
  { label: 'Summarise a file', icon: 'file', prompt: 'Summarise this file in a few bullet points:\n\n' },
  { label: 'Explain this code', icon: 'code', prompt: 'Explain what this code does, step by step:\n\n' },
  { label: 'Draft an email', icon: 'pencil', prompt: 'Draft a short, friendly email to ' },
  { label: 'Plan my week', icon: 'calendar', prompt: 'Help me plan my week. Here is what I need to get done:\n\n' },
  { label: 'Brainstorm ideas', icon: 'bulb', prompt: 'Brainstorm 10 ideas for ' }
]
