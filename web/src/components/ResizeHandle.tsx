import { useRef, type PointerEvent } from 'react'

export function ResizeHandle({
  label,
  value,
  min,
  max,
  direction = 1,
  onResize
}: {
  label: string
  value: number
  min: number
  max: number
  direction?: 1 | -1
  onResize: (value: number) => void
}) {
  const start = useRef<{ x: number; value: number } | null>(null)
  const update = (value: number) => onResize(Math.min(max, Math.max(min, value)))
  const end = (event: PointerEvent<HTMLDivElement>) => {
    start.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, value }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (start.current) update(start.current.value + (event.clientX - start.current.x) * direction)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          update(value + (event.key === 'ArrowRight' ? 16 : -16) * direction)
        }
      }}
    />
  )
}
export function savedSize(key: string, fallback: number, min: number, max: number) {
  try {
    const n = Number(localStorage.getItem(key))
    return n >= min && n <= max ? n : fallback
  } catch {
    return fallback
  }
}
export function rememberSize(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* A sessão continua sem persistência. */
  }
}
