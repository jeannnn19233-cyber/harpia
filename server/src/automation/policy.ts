import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

// Regras de uma execução sem ninguém para aprovar (rotinas, revisão de PR, agente do Telegram):
// só estas ferramentas existem, e as de arquivo só alcançam estas pastas.
export interface AutomationPolicy {
  tools: string[]
  roots: string[]
}

// Ferramentas de cada tipo de execução automática. Nunca há Bash: sem humano olhando, o agente
// não roda comandos.
export const READ_TOOLS = ['Read', 'Glob', 'Grep']
export const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit']
export const WEB_TOOLS = ['WebFetch', 'WebSearch']

// Campo com o caminho em cada ferramenta de arquivo.
const PATH_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path']
}

// Caminho real, seguindo links simbólicos. Para arquivos que ainda não existem, resolve a pasta mais
// próxima que existe e junta o resto.
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return resolve(await realTarget(parent), path.slice(parent.length + 1))
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

// Devolve o motivo da recusa, ou null quando a ferramenta pode rodar.
export async function checkToolUse(
  policy: AutomationPolicy,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): Promise<string | null> {
  if (!policy.tools.includes(toolName)) return `A ferramenta ${toolName} não está liberada nesta execução.`
  const roots = await Promise.all(policy.roots.map((root) => realTarget(root)))
  for (const field of PATH_FIELDS[toolName] ?? []) {
    const value = input[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return 'Caminho inválido.'
    const target = await realTarget(isAbsolute(value) ? value : resolve(cwd, value))
    if (!roots.some((root) => inside(target, root))) return `Fora das pastas permitidas: ${value}`
  }
  return null
}
