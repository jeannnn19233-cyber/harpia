// O Telegram aceita até 4096 caracteres por mensagem e um HTML bem limitado. As respostas dos
// agentes vêm em markdown: aqui viram o HTML que o Telegram entende, em partes que cabem.

const LIMIT = 3900

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text: string): string {
  const codes: string[] = []
  let result = escape(text).replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  result = result
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  return result.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)])
}

export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      out.push(`<pre>${escape(body.join('\n'))}</pre>`)
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`)
      continue
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2])}`)
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      out.push(`<i>${inline(quote[1])}</i>`)
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('──────')
      continue
    }
    out.push(inline(line))
  }
  return out.join('\n')
}

// Divide em partes de até ~3900 caracteres, preferindo quebrar entre parágrafos e linhas.
export function splitMessage(text: string, limit = LIMIT): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}
