// Leitura do diff unificado do git: quais linhas do arquivo novo aparecem no diff (só nelas o
// GitHub aceita comentário), corte de diffs grandes e caça a segredos adicionados.

export interface DiffFile {
  path: string
  // Linhas do arquivo novo presentes no diff (adicionadas ou de contexto).
  lines: Set<number>
  // Linhas adicionadas, com o número no arquivo novo.
  added: { line: number; text: string }[]
  patch: string
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = { path: '', lines: new Set(), added: [], patch: raw }
      files.push(current)
      continue
    }
    if (!current) continue
    current.patch += `\n${raw}`
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4)
      current.path = target === '/dev/null' ? '' : target.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('--- ')) continue
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+')) {
      current.lines.add(line)
      current.added.push({ line, text: raw.slice(1) })
      line++
    } else if (raw.startsWith(' ')) {
      current.lines.add(line)
      line++
    }
  }
  return files.filter((file) => file.path)
}

// Diff que cabe no contexto do agente: arquivos inteiros até o limite; o resto vira lista
// (o agente pode abrir esses arquivos na cópia do PR).
export function fitDiff(files: DiffFile[], budget = 60000): { text: string; omitted: string[] } {
  const parts: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const file of files) {
    if (used + file.patch.length > budget) {
      omitted.push(file.path)
      continue
    }
    parts.push(file.patch)
    used += file.patch.length
  }
  return { text: parts.join('\n'), omitted }
}

// Formatos comuns de segredo. Achados viram aviso crítico, e nunca são republicados.
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'token do GitHub', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'chave da Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'chave da OpenAI', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'chave da AWS', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'token do Slack', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'chave privada', pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'token do Telegram', pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { name: 'senha no código', pattern: /\b(password|senha|secret|api_?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i }
]

export function scanSecrets(files: DiffFile[]): { path: string; line: number; kind: string }[] {
  const found: { path: string; line: number; kind: string }[] = []
  for (const file of files) {
    for (const added of file.added) {
      const match = SECRET_PATTERNS.find(({ pattern }) => pattern.test(added.text))
      if (match) found.push({ path: file.path, line: added.line, kind: match.name })
    }
  }
  return found
}

// Esconde qualquer coisa com cara de segredo antes de publicar no GitHub ou no Telegram.
export function maskSecrets(text: string): string {
  let masked = text
  for (const { pattern } of SECRET_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), (value) => `${value.slice(0, 4)}…[oculto]`)
  }
  return masked
}
