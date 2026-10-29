import type { CSSProperties } from 'react'

const paths = {
  board: 'M3 4h18v16H3z M9 4v16 M15 4v16 M5.5 8h1 M11.5 8h1 M17.5 8h1',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  plus: 'M12 5v14 M5 12h14',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  spark: 'M12 3l2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8z',
  folder: 'M3 7V5h6l2 2h10v13H3z',
  chevron: 'M9 5l7 7-7 7',
  logout: 'M9 4H3v16h6 M14 8l4 4-4 4 M8 12h13',
  branch:
    'M6 6v12 M18 6v4a8 8 0 0 1-8 8 M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  arrow: 'M5 12h14 M12 5l7 7-7 7',
  leaf: 'M20 3C9 2 3 7 4 14s14 9 16-11z M5 20l9-10',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M6 18L18 6',
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  filter: 'M4 6h16 M7 12h10 M10 18h4'
}
export function Icon({ name, size = 18, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  )
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <img src="/brand/harpia-amazonia.png" alt="" />
      {!compact && (
        <span>
          harpia<span className="brand-dot">.</span>
        </span>
      )}
    </span>
  )
}
