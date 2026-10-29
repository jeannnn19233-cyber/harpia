import type { PrQueue, User } from '../../../shared/types.ts'
import type { CheckRunInfo, PullDetail, PullReviewInfo } from '../github/client.ts'

// Filas do revisor (port do revisor_clarumi.py do Hermes), decididas sem IA a partir do estado
// do PR no GitHub. Generalizado para a equipe: cada pessoa tem o próprio revisor (o Claude e o
// token do GitHub dela), e quem revisa um PR nunca é o autor.

// Ordem de prioridade da skill: CONFLITO de PR aprovada → CORRIGIR → CONFLITO → ADIANTAR → REVISAR → RETESTAR.
export const PRIORITY = { conflitoAprovada: 1, corrigir: 2, conflito: 3, adiantar: 4, revisar: 5, retestar: 6 } as const

export interface Person {
  user: User
  // Tem o GitHub conectado e o revisor ligado: pode trabalhar sozinho em nome dela.
  bot: boolean
}

export interface PlannedJob {
  queue: PrQueue
  key: string
  actorId: number
  priority: number
  // Para a fila CORRIGIR: a revisão de pessoa que motivou.
  reviewId?: number
}

export interface PullState {
  pr: PullDetail
  reviews: PullReviewInfo[]
  checks: CheckRunInfo[]
  // Topo da branch de destino (a chave do CONFLITO é o par topo do PR + topo da main).
  baseSha: string
  // Revisões publicadas pelo próprio Harpia (as outras são de pessoas).
  published: Set<number>
  // Só revisões de pessoas feitas depois de ligar o revisor entram na fila CORRIGIR.
  since: string | null
}

export interface Team {
  byLogin: (login: string) => Person | null
  byId: (id: number) => Person | null
  defaultReviewerId: number | null
}

// Quem revisa: quem o autor marcou no GitHub (com o revisor ligado), senão o revisor preferido do
// autor, senão o padrão do projeto. Nunca o autor.
export function resolveReviewer(pr: PullDetail, team: Team): Person | null {
  const author = team.byLogin(pr.authorLogin)
  const requested = pr.requestedReviewers.map((login) => team.byLogin(login)).filter((person): person is Person => person !== null)
  const requestedBot = requested.find((person) => person.bot && person.user.id !== author?.user.id)
  if (requestedBot) return requestedBot
  if (pr.requestedReviewers.length > 0) return null
  for (const id of [author?.user.preferredReviewerId ?? null, team.defaultReviewerId]) {
    const person = id ? team.byId(id) : null
    if (person?.bot && person.user.id !== author?.user.id) return person
  }
  return null
}

// Revisor humano marcado no PR (sem revisor automático ligado): o autor pode adiantar a análise.
export function humanReviewerRequested(pr: PullDetail, team: Team): boolean {
  return pr.requestedReviewers.some((login) => {
    const person = team.byLogin(login)
    return !person || !person.bot
  })
}

// CI que falhou rápido demais para ter rodado (ex.: bloqueio de faturamento do GitHub Actions):
// todos os checks com falha terminaram em menos de 30 s.
export function ciFailedTooFast(checks: CheckRunInfo[]): boolean {
  const failures = checks.filter((check) => check.conclusion === 'failure')
  if (failures.length === 0) return false
  for (const check of failures) {
    if (!check.startedAt || !check.completedAt) continue
    const seconds = (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000
    if (seconds >= 30) return false
  }
  return true
}

// Aprovado: a última revisão de alguém que decidiu é APPROVED.
export function isApproved(reviews: PullReviewInfo[]): boolean {
  const last = new Map<string, PullReviewInfo['state']>()
  for (const review of reviews) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') last.set(review.login, review.state)
  }
  return [...last.values()].includes('APPROVED') && ![...last.values()].includes('CHANGES_REQUESTED')
}

// Revisões de pessoas que pedem algo do autor (fila CORRIGIR).
export function humanReviewsToHandle(state: PullState): PullReviewInfo[] {
  return state.reviews.filter(
    (review) =>
      !state.published.has(review.id) &&
      review.login !== state.pr.authorLogin &&
      (review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED' || (review.state === 'APPROVED' && review.body.trim() !== '')) &&
      (!state.since || !review.submittedAt || review.submittedAt >= state.since)
  )
}

// Tudo o que este PR pede agora, uma entrada por fila (a chave diz quando já foi tratado).
export function planPull(state: PullState, team: Team): PlannedJob[] {
  const { pr } = state
  const jobs: PlannedJob[] = []
  const author = team.byLogin(pr.authorLogin)
  const authorBot = author?.bot ? author : null
  const reviewer = resolveReviewer(pr, team)

  if (pr.draft) return jobs

  // CONFLITO: qualquer autor, inclusive PR já aprovada.
  if (pr.mergeableState === 'dirty' || pr.mergeable === false) {
    const actor = authorBot ?? reviewer
    if (actor) {
      jobs.push({
        queue: 'conflito',
        key: `${pr.headSha}:${state.baseSha}`,
        actorId: actor.user.id,
        priority: isApproved(state.reviews) ? PRIORITY.conflitoAprovada : PRIORITY.conflito
      })
    }
  }

  // CORRIGIR: revisão de uma pessoa ainda não tratada; quem corrige é o revisor do autor.
  if (authorBot) {
    for (const review of humanReviewsToHandle(state)) {
      jobs.push({ queue: 'corrigir', key: `review:${review.id}`, actorId: authorBot.user.id, priority: PRIORITY.corrigir, reviewId: review.id })
    }
  }

  // REVISAR: há um revisor (que não é o autor) com o revisor ligado.
  if (reviewer) {
    jobs.push({ queue: 'revisar', key: pr.headSha, actorId: reviewer.user.id, priority: PRIORITY.revisar })
  } else if (authorBot && humanReviewerRequested(pr, team)) {
    // ADIANTAR: o autor marcou uma pessoa que revisa à mão; o revisor do autor adianta a análise.
    jobs.push({ queue: 'adiantar', key: pr.headSha, actorId: authorBot.user.id, priority: PRIORITY.adiantar })
  }

  // RETESTAR: CI que falhou rápido demais; testa localmente e só comenta.
  if (ciFailedTooFast(state.checks)) {
    const actor = reviewer ?? authorBot
    if (actor) jobs.push({ queue: 'retestar', key: pr.headSha, actorId: actor.user.id, priority: PRIORITY.retestar })
  }
  return jobs
}
