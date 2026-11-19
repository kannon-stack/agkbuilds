/** Small line-icon set (24×24, drawn with currentColor) so icons follow the theme instead of emoji. */
const PATHS = {
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>,
  pencil: <path d="M12 20h8M4 20l1-4L16 5l3 3L8 19z" />,
  edit: <path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  clip: <path d="M20.5 11.5l-8.3 8.3a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" />,
  folder: <path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2h7.5A2.5 2.5 0 0121 9.5v7a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 16.5z" />,
  memory: <path d="M6.5 4h11v16l-5.5-3.6L6.5 20z" />,
  skill: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0013.5 4h-7A2.5 2.5 0 004 6.5v7A2.5 2.5 0 006.5 16H8" /></>,
  redo: <><path d="M20 12a8 8 0 11-2.4-5.7L20 8.5" /><path d="M20 4v4.5h-4.5" /></>,
  more: <><circle cx="5.5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18.5" cy="12" r="1" /></>,
  gear: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /></>,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  file: <><path d="M14 3.5H7A2 2 0 005 5.5v13a2 2 0 002 2h10a2 2 0 002-2v-10z" /><path d="M14 3.5v5h5" /></>,
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3z" />,
  server: <><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01" /></>,
  tools: <path d="M14.5 6.5a4 4 0 00-5.2 5.2L4 17v3h3l5.3-5.3a4 4 0 005.2-5.2l-2.5 2.5-2.5-.5-.5-2.5z" />,
  plug: <path d="M9 7V3.5M15 7V3.5M7 7h10v4a5 5 0 01-10 0zM12 16v4.5" />,
  drop: <path d="M12 3.5s6 6.6 6 10.7a6 6 0 01-12 0c0-4.1 6-10.7 6-10.7z" />,
  sliders: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="1.8" /><circle cx="15" cy="12" r="1.8" /><circle cx="8" cy="18" r="1.8" /></>,
  book: <><path d="M5 4.5h9.5A3.5 3.5 0 0118 8v11.5H8.5A3.5 3.5 0 015 16z" /><path d="M9 9h5M9 12.5h3" /></>,
  terminal: <path d="M5 7l5 5-5 5M12.5 17H19" />,
  refresh: <><path d="M20 12a8 8 0 11-2.4-5.7L20 8.5" /><path d="M20 4v4.5h-4.5" /></>
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {PATHS[name]}
    </svg>
  )
}

/** The Talaria mark (filled four-point sparkle) in the accent colour. */
export function Mark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={`mark ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path fill="currentColor" d="M12 2.5l2.1 6.2 6.4 2.3-6.4 2.3L12 19.5l-2.1-6.2L3.5 11l6.4-2.3z" />
    </svg>
  )
}
