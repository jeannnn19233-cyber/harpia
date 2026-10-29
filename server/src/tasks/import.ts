import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TaskStatus, User } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

// Importação de um quadro de tarefas exportado de outro lugar (hoje, o quadro do Clarumi em
// JSON: { tarefas: [...] }). Cada cartão vira uma task; o código dele (ex.: J15) fica guardado
// para reimportar sem duplicar.

const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? '' : String(value).trim()))

const cardSchema = z.object({
  id: z.string().trim().min(1).max(40),
  titulo: z.string().trim().min(1).max(500),
  status: z.string().trim().max(40),
  dono: text,
  fase: text,
  periodo: text,
  horas: text,
  etiqueta: text,
  depende_de: text,
  objetivo: text,
  passos: text,
  como_testar: text,
  pronto_quando: text,
  arquivos: text,
  ultima_nota: text,
  nota_completa: text,
  atualizado_em: text,
  atualizado_por: text
})

export const importSchema = z.object({
  tarefas: z.array(cardSchema).min(1, 'O arquivo não tem nenhuma tarefa.').max(3000),
  // Por padrão só os cartões abertos; os feitos lotariam a coluna Feito.
  incluirFeitas: z.boolean().default(false)
})

export type ImportCard = z.infer<typeof cardSchema>

const STATUS: Record<string, TaskStatus> = {
  feito: 'done',
  fazendo: 'in_progress',
  'em andamento': 'in_progress',
  bloqueado: 'backlog',
  revisao: 'review',
  'a fazer': 'backlog',
  backlog: 'backlog'
}

const plain = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

export function mapStatus(status: string): TaskStatus | null {
  return STATUS[plain(status)] ?? null
}

// Dono pelo primeiro nome (sem acento, sem maiúscula). Nome repetido na equipe fica sem dono:
// melhor sem responsável do que com o responsável errado.
export function ownerFor(name: string, users: User[]): number | null {
  const wanted = plain(name)
  if (!wanted || wanted === 'a definir') return null
  const matches = users.filter((user) => plain(user.name).split(/\s+/)[0] === wanted.split(/\s+/)[0])
  return matches.length === 1 ? matches[0].id : null
}

const SAFE_TITLE = 200

export function cardTitle(card: ImportCard): string {
  const title = `${card.id} · ${card.titulo}`
  return title.length > SAFE_TITLE ? `${title.slice(0, SAFE_TITLE - 1)}…` : title
}

// O texto do quadro separa itens com " | ".
function bullets(value: string): string {
  const items = value
    .split(/\s+\|\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 1 ? items.map((item) => `- ${item}`).join('\n') : (items[0] ?? '')
}

export function cardDescription(card: ImportCard, ownerResolved: boolean): string {
  const parts: string[] = []
  if (plain(card.status) === 'bloqueado') parts.push('> **Bloqueado** no quadro de origem. Veja a última nota.')
  const meta = [
    card.fase && `**Fase:** ${card.fase}${card.periodo && card.periodo !== 'a' ? ` (${card.periodo})` : ''}`,
    card.dono && !ownerResolved && `**Dono:** ${card.dono}`,
    card.depende_de && `**Depende de:** ${card.depende_de}`,
    card.etiqueta && `**Etiqueta:** ${card.etiqueta}`,
    card.horas && card.horas !== '—' && `**Horas:** ${card.horas}`
  ].filter(Boolean)
  if (meta.length) parts.push(meta.join(' · '))
  const sections: [string, string][] = [
    ['Objetivo', card.objetivo],
    ['Passos', bullets(card.passos)],
    ['Como testar', bullets(card.como_testar)],
    ['Pronto quando', bullets(card.pronto_quando)],
    ['Arquivos', bullets(card.arquivos)],
    ['Notas', bullets(card.nota_completa || card.ultima_nota)]
  ]
  for (const [title, body] of sections) if (body) parts.push(`## ${title}\n\n${body}`)
  const origin = [`Importada do quadro de origem (${card.id})`]
  if (card.atualizado_em) origin.push(`atualizada lá em ${card.atualizado_em.slice(0, 10)}${card.atualizado_por ? ` por ${card.atualizado_por}` : ''}`)
  parts.push(`_${origin.join(', ')}._`)
  return parts.join('\n\n').slice(0, 20000)
}

export interface ExistingTask {
  id: number
  title: string
  description: string
  status: TaskStatus
  ownerId: number | null
  externalId: string
  externalHash: string | null
}

export interface PlannedCard {
  card: ImportCard
  status: TaskStatus
  title: string
  description: string
  ownerId: number | null
  existing: ExistingTask | null
  action: 'create' | 'update' | 'unchanged'
  hash: string
}

// Impressão digital do cartão como veio da origem: muda só quando o cartão muda lá.
export function cardHash(card: ImportCard): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 32)
}

export interface ImportPlan {
  cards: PlannedCard[]
  create: number
  update: number
  unchanged: number
  byStatus: Record<TaskStatus, number>
  unknownOwners: string[]
  invalid: { id: string; reason: string }[]
  // Cartões feitos deixados de fora (sem "incluir feitas").
  skippedDone: number
}

// Tasks já importadas: pelo código guardado, ou pelo código no começo do título ("J15 · …"),
// para adotar as que outro importador criou sem guardar o código (sem duplicar).
export function existingByExternal(db: Db, projectId: number): Map<string, ExistingTask> {
  const rows = db
    .prepare(
      `SELECT id, title, description, status, owner_id,
              COALESCE(external_id, CASE WHEN instr(title, ' · ') > 1 THEN substr(title, 1, instr(title, ' · ') - 1) END) AS external_id,
              external_hash
       FROM tasks WHERE project_id = ? ORDER BY tasks.external_id IS NULL, tasks.id`
    )
    .all(projectId) as {
    id: number
    title: string
    description: string
    status: TaskStatus
    owner_id: number | null
    external_id: string | null
    external_hash: string | null
  }[]
  const known = new Map<string, ExistingTask>()
  for (const row of rows) {
    // Código no título só vale se tiver cara de código (J15, L08, F1) e não estiver em uso.
    if (!row.external_id || !/^[A-Z]{1,4}\d{1,5}$/.test(row.external_id) || known.has(row.external_id)) continue
    known.set(row.external_id, {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      ownerId: row.owner_id,
      externalId: row.external_id,
      externalHash: row.external_hash
    })
  }
  return known
}

// O que a importação vai fazer, sem mexer em nada. Um cartão já importado só é atualizado se
// mudou na origem desde a última importação (impressão digital diferente): o que a equipe mudou
// no Harpia num cartão que não mudou lá fica como está.
export function planImport(cards: ImportCard[], users: User[], existing: Map<string, ExistingTask>, includeDone = true): ImportPlan {
  const byStatus: Record<TaskStatus, number> = { backlog: 0, in_progress: 0, review: 0, done: 0 }
  const unknownOwners = new Set<string>()
  const invalid: ImportPlan['invalid'] = []
  const seen = new Set<string>()
  const planned: PlannedCard[] = []
  let skippedDone = 0
  for (const card of cards) {
    if (seen.has(card.id)) {
      invalid.push({ id: card.id, reason: 'código repetido no arquivo' })
      continue
    }
    seen.add(card.id)
    const status = mapStatus(card.status)
    if (!status) {
      invalid.push({ id: card.id, reason: `status desconhecido: "${card.status}"` })
      continue
    }
    const before = existing.get(card.id) ?? null
    // Feita que ainda não está no Harpia só entra se pedirem; a que já está continua atualizada.
    if (status === 'done' && !before && !includeDone) {
      skippedDone++
      continue
    }
    const ownerId = ownerFor(card.dono, users)
    if (ownerId === null && card.dono && plain(card.dono) !== 'a definir') unknownOwners.add(card.dono)
    const hash = cardHash(card)
    const title = cardTitle(card)
    const description = cardDescription(card, ownerId !== null)
    const differs = !!before && (before.title !== title || before.description !== description || before.status !== status || before.ownerId !== ownerId)
    const action = !before ? 'create' : before.externalHash !== hash && differs ? 'update' : 'unchanged'
    byStatus[status]++
    planned.push({ card, status, title, description, ownerId, existing: before, action, hash })
  }
  return {
    cards: planned,
    create: planned.filter((item) => item.action === 'create').length,
    update: planned.filter((item) => item.action === 'update').length,
    unchanged: planned.filter((item) => item.action === 'unchanged').length,
    byStatus,
    unknownOwners: [...unknownOwners].sort(),
    invalid,
    skippedDone
  }
}
