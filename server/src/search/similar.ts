import type { SimilarTask, TaskStatus } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

// Palavras que não ajudam a dizer se duas tasks tratam do mesmo assunto.
const STOPWORDS = new Set(
  (
    'a o e de da do das dos em no na nos nas um uma uns umas para pra por com sem que se ao aos as os ' +
    'mais menos muito nao sim ser ter fazer feito criar ajustar corrigir melhorar tela pagina task tarefa ' +
    'via sobre novo nova novos novas ' +
    'the and for with to of in on'
  ).split(' ')
)

// Palavras significativas, sem acento e em minúsculas.
export function significantWords(text: string): string[] {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    // Plural simples: "pagamentos" e "pagamento" contam como a mesma palavra.
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
  return [...new Set(words)]
}

// Quanto dois títulos compartilham (0 a 1), comparando as palavras significativas.
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(significantWords(a))
  const right = new Set(significantWords(b))
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / Math.min(left.size, right.size)
}

// Tasks do projeto parecidas com o texto, para avisar antes de criar uma task repetida.
export function findSimilarTasks(
  db: Db,
  input: { projectId: number; text: string; excludeTaskId?: number; limit?: number }
): SimilarTask[] {
  const words = significantWords(input.text).slice(0, 12)
  if (words.length === 0) return []
  // Cada palavra vira um prefixo entre aspas: "checkout"* OR "pix"*
  const match = words.map((word) => `"${word}"*`).join(' OR ')
  const rows = db
    .prepare(
      `SELECT t.id, t.number, t.title, t.status
       FROM tasks_fts f JOIN tasks t ON t.id = f.rowid
       WHERE tasks_fts MATCH ? AND t.project_id = ? AND t.id != ?
       ORDER BY bm25(tasks_fts, 3.0, 1.0)
       LIMIT ?`
    )
    .all(match, input.projectId, input.excludeTaskId ?? -1, input.limit ?? 5) as {
    id: number
    number: number
    title: string
    status: TaskStatus
  }[]
  return rows.map((row) => ({ id: row.id, number: row.number, title: row.title, status: row.status }))
}
