import type { PrFinding, PrFindingStatus, PrMemory } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

// Memória por achado, por PR (port do revisor_memoria.py do Hermes): a rodada seguinte sabe o
// que já foi apontado e o que já foi resolvido, em vez de achar de novo.

const STATUS_VALIDOS: PrFindingStatus[] = ['aberto', 'resolvido', 'retirado']
const GRAVIDADES_VALIDAS = ['bloqueia', 'nao-bloqueia'] as const

export interface FindingUpdate {
  id?: string | null
  arquivo?: string | null
  linha?: number | null
  resumo?: string
  gravidade?: 'bloqueia' | 'nao-bloqueia'
  status?: PrFindingStatus
  nota?: string
}

export function novaMemoria(numero: number): PrMemory {
  return { numero, achados: [], rodadas: [], sha_revisado: null, visto_ate: null }
}

export function carregarMemoria(db: Db, projectId: number, numero: number): PrMemory {
  const row = db.prepare('SELECT data FROM pr_memories WHERE project_id = ? AND number = ?').get(projectId, numero) as
    | { data: string }
    | undefined
  if (!row) return novaMemoria(numero)
  try {
    return JSON.parse(row.data) as PrMemory
  } catch {
    return novaMemoria(numero)
  }
}

export function salvarMemoria(db: Db, projectId: number, mem: PrMemory, now: Date): void {
  db.prepare(
    `INSERT INTO pr_memories (project_id, number, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, number) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(projectId, mem.numero, JSON.stringify(mem), now.toISOString())
}

export function achadosAbertos(mem: PrMemory): PrFinding[] {
  return mem.achados.filter((achado) => achado.status === 'aberto')
}

export function achadosBloqueantesAbertos(mem: PrMemory): PrFinding[] {
  return achadosAbertos(mem).filter((achado) => achado.gravidade === 'bloqueia')
}

// Grava uma rodada (pura: devolve a memória nova). Item com id atualiza um achado existente; item
// sem id é achado novo (nasce com o id seguinte, aberto).
export function aplicarRodada(
  mem: PrMemory,
  achadosDaRodada: FindingUpdate[],
  input: { sha: string; em: string; evento: string | null; resumo: string }
): PrMemory {
  const nova = JSON.parse(JSON.stringify(mem)) as PrMemory
  const n = nova.rodadas.length + 1
  const porId = new Map(nova.achados.map((achado) => [achado.id, achado]))
  let proximo = Math.max(0, ...nova.achados.map((achado) => Number(achado.id.slice(1)) || 0)) + 1

  for (const item of achadosDaRodada) {
    const status = item.status ?? 'aberto'
    if (!STATUS_VALIDOS.includes(status)) throw new Error(`status inválido em achado: ${status}`)
    if (item.id) {
      const alvo = porId.get(item.id)
      if (!alvo) throw new Error(`achado ${item.id} não existe na memória; achado novo vai sem id`)
      if (item.arquivo !== undefined && item.arquivo !== null) alvo.arquivo = item.arquivo
      if (item.linha !== undefined && item.linha !== null) alvo.linha = item.linha
      if (item.resumo) alvo.resumo = item.resumo
      if (item.gravidade) alvo.gravidade = item.gravidade
      alvo.status = status
      alvo.historico.push({ rodada: n, sha: input.sha, status, nota: item.nota ?? '' })
    } else {
      if (!item.gravidade || !GRAVIDADES_VALIDAS.includes(item.gravidade)) throw new Error(`gravidade inválida em achado novo: ${item.gravidade}`)
      if (status !== 'aberto') throw new Error('achado novo nasce aberto')
      if (!item.resumo) throw new Error('achado novo precisa de resumo')
      nova.achados.push({
        id: `A${proximo}`,
        arquivo: item.arquivo ?? null,
        linha: item.linha ?? null,
        resumo: item.resumo,
        gravidade: item.gravidade,
        status: 'aberto',
        historico: [{ rodada: n, sha: input.sha, status: 'aberto', nota: item.nota ?? '' }]
      })
      proximo++
    }
  }
  nova.rodadas.push({ n, sha: input.sha, em: input.em, evento: input.evento, resumo: input.resumo })
  nova.sha_revisado = input.sha
  nova.visto_ate = input.em
  return nova
}

export function listarLicoes(db: Db, projectId: number, limit = 60): string[] {
  const rows = db
    .prepare('SELECT text, number, author_login, created_at FROM review_lessons WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as { text: string; number: number | null; author_login: string | null; created_at: string }[]
  return rows
    .reverse()
    .map((row) => `- ${row.created_at.slice(0, 10)}${row.number ? ` · PR #${row.number}` : ''}${row.author_login ? ` (@${row.author_login})` : ''}: ${row.text}`)
}

export function registrarLicao(db: Db, input: { projectId: number; text: string; number: number | null; author: string | null; now: Date }): void {
  db.prepare('INSERT INTO review_lessons (project_id, number, author_login, text, created_at) VALUES (?, ?, ?, ?, ?)').run(
    input.projectId,
    input.number,
    input.author,
    input.text.trim(),
    input.now.toISOString()
  )
}
