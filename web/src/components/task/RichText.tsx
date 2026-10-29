import { Fragment, type ReactNode } from 'react'

// Mostra o texto dos agentes com o básico de Markdown: blocos de código, `código`,
// **negrito** e listas. Sem HTML vindo de fora: tudo é texto escapado pelo React.
function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={index} className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.85em] text-amber-200">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    return <Fragment key={index}>{part}</Fragment>
  })
}

export function RichText({ text }: { text: string }) {
  const blocks = text.split(/```/)
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          const newline = block.indexOf('\n')
          const code = newline === -1 ? block : block.slice(newline + 1)
          return (
            <pre key={index} className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs">
              {code.replace(/\n$/, '')}
            </pre>
          )
        }
        return block
          .split(/\n{2,}/)
          .filter((paragraph) => paragraph.trim())
          .map((paragraph, p) => {
            const lines = paragraph.split('\n')
            if (lines.every((line) => /^\s*([-*]|\d+\.)\s/.test(line))) {
              return (
                <ul key={`${index}-${p}`} className="list-disc space-y-1 pl-5">
                  {lines.map((line, l) => (
                    <li key={l}>{inline(line.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>
                  ))}
                </ul>
              )
            }
            return (
              <p key={`${index}-${p}`} className="whitespace-pre-wrap">
                {inline(paragraph)}
              </p>
            )
          })
      })}
    </div>
  )
}
