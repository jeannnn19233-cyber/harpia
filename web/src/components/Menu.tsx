import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

// Menu suspenso do próprio Harpia (no lugar da lista do sistema, que fica ilegível no tema
// escuro em alguns sistemas). Um item pode ter um submenu, que abre ao lado (em cascata) ao passar
// o mouse, ao clicar ou com a seta para a direita.
export interface MenuOption {
  key: string
  label: string
  hint?: string
  checked?: boolean
  // Itens do submenu; com eles, o item abre a cascata em vez de escolher direto.
  children?: MenuOption[]
  onSelect?: () => void
}

export function Menu({ label, title, options, align = 'right' }: { label: ReactNode; title?: string; options: MenuOption[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [sub, setSub] = useState<number | null>(null)
  const [subActive, setSubActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  const close = (focus = false) => {
    setOpen(false)
    setSub(null)
    if (focus) trigger.current?.focus()
  }

  const openMenu = () => {
    const checked = options.findIndex((option) => option.checked || option.children?.some((child) => child.checked))
    setActive(Math.max(0, checked))
    setSub(null)
    setOpen(true)
  }

  const choose = (option: MenuOption, index: number) => {
    if (option.children?.length) {
      setActive(index)
      setSub(index)
      setSubActive(Math.max(0, option.children.findIndex((child) => child.checked)))
      return
    }
    option.onSelect?.()
    close(true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }
    const children = sub !== null ? (options[sub].children ?? []) : null
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        if (sub !== null) setSub(null)
        else close(true)
        return
      case 'ArrowDown':
        event.preventDefault()
        if (children) setSubActive((index) => (index + 1) % children.length)
        else setActive((index) => (index + 1) % options.length)
        return
      case 'ArrowUp':
        event.preventDefault()
        if (children) setSubActive((index) => (index - 1 + children.length) % children.length)
        else setActive((index) => (index - 1 + options.length) % options.length)
        return
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault()
        // O submenu abre do lado em que há espaço; as setas abrem e fecham.
        const opening = (event.key === 'ArrowLeft') === (align === 'right')
        if (opening && sub === null && options[active]?.children?.length) choose(options[active], active)
        else if (!opening && sub !== null) setSub(null)
        return
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (children) {
          children[subActive]?.onSelect?.()
          close(true)
        } else if (options[active]) choose(options[active], active)
        return
      case 'Tab':
        close()
        return
    }
  }

  return (
    <div className="harpia-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="harpia-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="harpia-menu-label">{label}</span>
        <span aria-hidden="true" className="harpia-menu-caret">▾</span>
      </button>
      {open && (
        <div role="menu" className={`harpia-menu-panel ${align}`}>
          {options.map((option, index) => (
            <div key={option.key} className="harpia-menu-row" onMouseEnter={() => (setActive(index), option.children?.length ? choose(option, index) : setSub(null))}>
              <button
                type="button"
                role={option.children ? 'menuitem' : 'menuitemradio'}
                aria-checked={option.children ? undefined : !!option.checked}
                aria-haspopup={option.children ? 'menu' : undefined}
                aria-expanded={option.children ? sub === index : undefined}
                className={`harpia-menu-item ${active === index || sub === index ? 'active' : ''} ${option.checked || option.children?.some((child) => child.checked) ? 'checked' : ''}`}
                onClick={() => choose(option, index)}
              >
                <span className="harpia-menu-check" aria-hidden="true">
                  {option.checked || option.children?.some((child) => child.checked) ? '✓' : ''}
                </span>
                <span className="harpia-menu-text">
                  {option.label}
                  {option.hint && <small>{option.hint}</small>}
                </span>
                {option.children?.length ? <span className="harpia-menu-arrow" aria-hidden="true">{align === 'right' ? '‹' : '›'}</span> : null}
              </button>
              {sub === index && option.children && (
                <div role="menu" className={`harpia-menu-panel harpia-menu-sub ${align}`}>
                  {option.children.map((child, childIndex) => (
                    <button
                      key={child.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={!!child.checked}
                      className={`harpia-menu-item ${subActive === childIndex ? 'active' : ''} ${child.checked ? 'checked' : ''}`}
                      onMouseEnter={() => setSubActive(childIndex)}
                      onClick={() => {
                        child.onSelect?.()
                        close(true)
                      }}
                    >
                      <span className="harpia-menu-check" aria-hidden="true">
                        {child.checked ? '✓' : ''}
                      </span>
                      <span className="harpia-menu-text">
                        {child.label}
                        {child.hint && <small>{child.hint}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
