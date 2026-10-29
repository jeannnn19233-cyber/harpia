import { createHash } from 'node:crypto'
import type { PrReviewCounts, Project, User } from '../../../shared/types.ts'
import { reviewBranch } from '../agents/user-git.ts'
import { agentsDisabledReason, publishTaskChange } from '../agents/workspace.ts'
import { getGitHubAccount } from '../auth/github-accounts.ts'
import { getUser, listUsers } from '../auth/users.ts'
import { REVIEWER_TOOLS } from '../automation/policy.ts'
import type { ChatManager } from '../chat/manager.ts'
import { insertChat } from '../chat/store.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo, type GitHubClient, type GitHubRepo, type PullDetail, type PullReviewInfo, type ReviewComment } from '../github/client.ts'
import { withGitHubReader } from '../github/reader.ts'
import { HttpError } from '../http/errors.ts'
import { getMemory } from '../memory/store.ts'
import { projectPath } from '../projects/routes.ts'
import { getProject, getReviewSettings, listProjects } from '../projects/store.ts'
import { insertEvent } from '../tasks/store.ts'
import { fitDiff, maskSecrets, parseDiff } from './diff.ts'
import { PADRAO_ASSINATURA, limparAssinatura, mapaDoDiff, separarComentarios, validarCommits, validarRevisao } from './gate.ts'
import { aplicarRodada, carregarMemoria, listarLicoes, registrarLicao, salvarMemoria } from './memory.ts'
import { entryLine, parseReviewerResult, reviewerInstructions, verdictOf, type ReviewerResult } from './prompt.ts'
import { isApproved, planPull, type Person, type PlannedJob, type PullState, type Team } from './queues.ts'
import {
  findJob,
  getFlags,
  getJob,
  getSetting,
  insertJob,
  lastHandledSha,
  listPullJobs,
  listWaitingJobs,
  publicJob,
  publishedIds,
  pushedByReviewer,
  recordPublished,
  requeueRunningJobs,
  setFlag,
  setSetting,
  updateJob,
  type StoredJob
} from './store.ts'

export interface ReviewerOptions {
  // De quanto em quanto tempo o servidor olha os PRs abertos. 0 desliga o laço (testes).
  pollSeconds: number
  // Espera o PR ficar esse tempo sem commits novos antes de revisar (pushes seguidos viram uma revisão).
  settleSeconds: number
  maxConcurrent: number
  inactivityMs?: number
  maxMs?: number
  // Depois de uma falha, espera esse tempo antes de tentar de novo (no Hermes: a próxima volta do cron).
  retrySeconds?: number
}

// Rótulo que tira um PR do revisor.
export const SKIP_LABEL = 'sem-revisao-ia'
// Como no Hermes: depois de 3 falhas na mesma entrada, ela sai da fila até alguém pedir de novo.
export const MAX_ATTEMPTS = 3
// Avisa no Telegram depois de tantas falhas seguidas do revisor de uma pessoa (vigia-cron-revisor).
const STREAK_ALERT = 3

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function firstName(user: User | null): string {
  return user?.name.split(' ')[0] ?? 'alguém'
}

// Revisor de PRs da equipe (fases 6 e revisor v2): portado do revisor-prs-clarumi do Hermes.
// O servidor monta as filas sem IA; o Claude de quem revisa analisa, corrige e roda as suítes numa
// cópia do PR; o servidor confere tudo no portão, envia os commits e publica com o token dela.
export class PrReviewer {
  private readonly ctx: AppContext
  private readonly manager: ChatManager
  private readonly options: ReviewerOptions
  private readonly running = new Map<number, Promise<void>>()
  private readonly busyActors = new Set<number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null

  constructor(ctx: AppContext, manager: ChatManager, options: ReviewerOptions) {
    this.ctx = ctx
    this.manager = manager
    this.options = options
  }

  start(): void {
    requeueRunningJobs(this.ctx.db, this.ctx.now())
    if (this.options.pollSeconds > 0) {
      this.timer = setInterval(() => void this.poll(), this.options.pollSeconds * 1000)
      this.timer.unref()
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.polling
    await this.idle()
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()])
  }

  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollAll()
        .catch(() => undefined)
        .finally(() => {
          this.polling = null
        })
    }
    return this.polling
  }

  // ── Equipe ────────────────────────────────────────────────────────────────────────────────

  private team(project: Project): Team {
    const people = listUsers(this.ctx.db).map(
      (user): Person => ({ user, bot: user.githubConnected && user.reviewMode !== 'off' })
    )
    return {
      byLogin: (login) => people.find((person) => person.user.githubLogin?.toLowerCase() === login.toLowerCase()) ?? null,
      byId: (id) => people.find((person) => person.user.id === id) ?? null,
      defaultReviewerId: project.defaultReviewerId
    }
  }

  private clientFor(user: User): { client: GitHubClient; token: string; login: string } | null {
    const account = getGitHubAccount(this.ctx.db, this.ctx.secrets, user.id)
    return account ? { client: this.ctx.githubFor(account.token), token: account.token, login: account.login } : null
  }

  // ── Filas (sem IA) ────────────────────────────────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    for (const project of listProjects(this.ctx.db)) {
      const repo = parseGitHubRepo(project.repoUrl)
      if (!project.prReview || !repo || project.cloneStatus !== 'ready') continue
      try {
        await this.pollProject(project, repo)
      } catch {
        // GitHub fora do ar ou token sem permissão: tenta na próxima volta.
      }
    }
    this.dispatch()
  }

  private async pollProject(project: Project, repo: GitHubRepo): Promise<void> {
    const team = this.team(project)
    const since = getReviewSettings(this.ctx.db, project.id).since
    const { client: github, open } = await withGitHubReader(this.ctx, async (client) => ({ client, open: await client.listOpenPullRequests(repo) }))
    const baseShas = new Map<string, string>()
    for (const summary of open) {
      if (summary.labels.includes(SKIP_LABEL)) continue
      const pr = await github.getPull(repo, summary.number)
      const reviews = await github.listReviews(repo, pr.number)
      await this.requestPreferredReviewer(project, repo, pr, reviews, team)
      await this.cleanSignatures(project, repo, pr, reviews, team)
      if (!baseShas.has(pr.baseRef)) baseShas.set(pr.baseRef, await github.getBranchSha(repo, pr.baseRef).catch(() => ''))
      const state: PullState = {
        pr,
        reviews,
        checks: await github.listCheckRuns(repo, pr.headSha).catch(() => []),
        baseSha: baseShas.get(pr.baseRef) ?? '',
        published: publishedIds(this.ctx.db, project.id, pr.number),
        since
      }
      for (const plan of planPull(state, team)) this.enqueue(project, pr, plan)
      // Entradas de commits antigos que ainda esperavam: chegou commit novo, valem as novas.
      for (const job of listPullJobs(this.ctx.db, project.id, pr.number)) {
        if (job.status === 'waiting' && ['revisar', 'adiantar', 'retestar'].includes(job.queue) && job.triggerKey !== pr.headSha) {
          this.publish(updateJob(this.ctx.db, job.id, { status: 'skipped', error: 'Chegou um commit novo antes desta execução.' }, this.ctx.now()))
        }
      }
    }
    // PRs fechados ou mesclados: o que esperava deixa de valer.
    const openNumbers = new Set(open.map((pr) => pr.number))
    for (const job of listWaitingJobs(this.ctx.db)) {
      if (job.projectId === project.id && !openNumbers.has(job.number)) {
        this.publish(updateJob(this.ctx.db, job.id, { status: 'skipped', error: 'O PR foi fechado ou mesclado.' }, this.ctx.now()))
      }
    }
  }

  private enqueue(project: Project, pr: PullDetail, plan: PlannedJob): void {
    const existing = findJob(this.ctx.db, project.id, pr.number, plan.queue, plan.key)
    const now = this.ctx.now()
    if (!existing) {
      // O commit que o próprio revisor enviou não volta para a revisão (passo 13 da skill).
      const own = ['revisar', 'adiantar', 'retestar'].includes(plan.queue) && pushedByReviewer(this.ctx.db, project.id, pr.number, pr.headSha, plan.actorId)
      this.publish(
        insertJob(this.ctx.db, {
          projectId: project.id,
          number: pr.number,
          queue: plan.queue,
          key: plan.key,
          headSha: pr.headSha,
          title: pr.title,
          url: pr.url,
          authorLogin: pr.authorLogin,
          reviewerId: plan.actorId,
          status: own ? 'skipped' : 'waiting',
          priority: plan.priority,
          error: own ? 'Commit enviado pelo próprio revisor.' : null,
          trigger: 'auto',
          now
        })
      )
      return
    }
    if (existing.status === 'waiting' && existing.priority !== plan.priority) {
      updateJob(this.ctx.db, existing.id, { priority: plan.priority }, now)
    }
  }

  // Pede no GitHub o revisor preferido do autor (ou o padrão do projeto), uma vez por PR — como a
  // marcação automática do revisor do Hermes. Se o autor tirar depois, a escolha dele vale.
  private async requestPreferredReviewer(project: Project, repo: GitHubRepo, pr: PullDetail, reviews: PullReviewInfo[], team: Team): Promise<void> {
    if (pr.draft || getFlags(this.ctx.db, project.id, pr.number).reviewerRequested) return
    const author = team.byLogin(pr.authorLogin)
    const targetId = author?.user.preferredReviewerId ?? project.defaultReviewerId
    const target = targetId ? team.byId(targetId) : null
    const login = target?.user.githubLogin
    if (!target || !login || target.user.id === author?.user.id) return
    const already =
      pr.requestedReviewers.some((name) => name.toLowerCase() === login.toLowerCase()) ||
      reviews.some((review) => review.login.toLowerCase() === login.toLowerCase())
    if (!already) {
      const client = (author ? this.clientFor(author.user)?.client : null) ?? (target.bot ? this.clientFor(target.user)?.client : null) ?? this.ctx.github
      try {
        await client.requestReviewers(repo, pr.number, [login])
        pr.requestedReviewers = [...pr.requestedReviewers, login]
      } catch {
        return
      }
    }
    setFlag(this.ctx.db, project.id, pr.number, 'reviewer_requested', true)
  }

  // Fila ASSINATURA, sem IA: tira o rodapé de ferramenta do corpo, das revisões e dos comentários
  // do autor (com o token dele). O corpo é conferido a cada volta (pode voltar depois de uma edição).
  private async cleanSignatures(project: Project, repo: GitHubRepo, pr: PullDetail, reviews: PullReviewInfo[], team: Team): Promise<void> {
    const author = team.byLogin(pr.authorLogin)
    if (!author?.bot) return
    const account = this.clientFor(author.user)
    if (!account) return
    const record = (key: string, line: string) => {
      if (findJob(this.ctx.db, project.id, pr.number, 'assinatura', key)) return
      this.publish(
        insertJob(this.ctx.db, {
          projectId: project.id,
          number: pr.number,
          queue: 'assinatura',
          key,
          headSha: pr.headSha,
          title: pr.title,
          url: pr.url,
          authorLogin: pr.authorLogin,
          reviewerId: author.user.id,
          status: 'posted',
          priority: 9,
          trigger: 'auto',
          now: this.ctx.now()
        })
      )
      const job = findJob(this.ctx.db, project.id, pr.number, 'assinatura', key)
      if (job) this.publish(updateJob(this.ctx.db, job.id, { line }, this.ctx.now()))
    }
    try {
      if (PADRAO_ASSINATURA.test(pr.body)) {
        const clean = limparAssinatura(pr.body)
        if (clean !== pr.body) {
          await account.client.updatePullBody(repo, pr.number, clean)
          record(`body:${hash(pr.body)}`, `#${pr.number} — limpei a assinatura de ferramenta do corpo`)
          pr.body = clean
        }
      }
      for (const review of reviews) {
        if (review.login !== pr.authorLogin || !PADRAO_ASSINATURA.test(review.body)) continue
        if (findJob(this.ctx.db, project.id, pr.number, 'assinatura', `review:${review.id}`)) continue
        await account.client.updateReviewBody(repo, pr.number, review.id, limparAssinatura(review.body))
        record(`review:${review.id}`, `#${pr.number} — limpei a assinatura de ferramenta de uma revisão`)
      }
      for (const comment of await account.client.listIssueComments(repo, pr.number)) {
        if (comment.login !== pr.authorLogin || !PADRAO_ASSINATURA.test(comment.body)) continue
        if (findJob(this.ctx.db, project.id, pr.number, 'assinatura', `comment:${comment.id}`)) continue
        await account.client.updateIssueComment(repo, comment.id, limparAssinatura(comment.body))
        record(`comment:${comment.id}`, `#${pr.number} — limpei a assinatura de ferramenta de um comentário`)
      }
    } catch {
      // Sem permissão para editar: tenta de novo na próxima volta.
    }
  }

  // ── Despacho: um PR por vez por pessoa, na ordem de prioridade da skill ───────────────────────

  dispatch(): void {
    const now = this.ctx.now().getTime()
    for (const job of listWaitingJobs(this.ctx.db)) {
      if (this.running.size >= this.options.maxConcurrent) return
      if (!job.reviewerId || this.busyActors.has(job.reviewerId) || this.running.has(job.id)) continue
      const settles = job.trigger === 'auto' && ['revisar', 'adiantar'].includes(job.queue)
      if (settles && now - new Date(job.createdAt).getTime() < this.options.settleSeconds * 1000) continue
      const retryMs = (this.options.retrySeconds ?? 300) * 1000
      if (job.attempts > 0 && now - new Date(job.updatedAt).getTime() < retryMs) continue
      this.launch(job)
    }
  }

  private launch(job: StoredJob): void {
    const actorId = job.reviewerId as number
    this.busyActors.add(actorId)
    const promise = this.execute(job)
      .catch((error) => this.fail(job, (error as Error).message))
      .finally(() => {
        this.running.delete(job.id)
        this.busyActors.delete(actorId)
        this.dispatch()
      })
    this.running.set(job.id, promise)
  }

  // "Revisar agora" com o revisor de quem pediu (que não pode ser o autor).
  async requestReview(project: Project, number: number, user: User): Promise<StoredJob> {
    const repo = parseGitHubRepo(project.repoUrl)
    if (!repo) throw new HttpError(400, 'O repositório deste projeto não é do GitHub.')
    if (!user.githubConnected) throw new HttpError(400, 'Conecte o seu GitHub em "Minhas IAs" para revisar com o seu revisor.')
    if (user.reviewMode === 'off') throw new HttpError(400, 'O seu revisor está desligado em "Minhas IAs".')
    const account = this.clientFor(user)
    if (!account) throw new HttpError(400, 'Conecte o seu GitHub em "Minhas IAs" para revisar com o seu revisor.')
    const pr = await account.client.getPull(repo, number).catch(() => null)
    if (!pr || pr.state !== 'open') throw new HttpError(404, `O PR #${number} não está aberto no GitHub.`)
    if (pr.authorLogin.toLowerCase() === user.githubLogin?.toLowerCase()) {
      throw new HttpError(400, 'Você é o autor deste PR: peça a revisão para outra pessoa da equipe.')
    }
    const now = this.ctx.now()
    const existing = findJob(this.ctx.db, project.id, number, 'revisar', pr.headSha)
    if (existing && (existing.status === 'running' || this.running.has(existing.id))) throw new HttpError(409, 'Este PR já está sendo revisado.')
    const job = existing
      ? (updateJob(this.ctx.db, existing.id, { status: 'waiting', reviewerId: user.id, trigger: 'manual', attempts: 0, error: null, title: pr.title }, now) as StoredJob)
      : insertJob(this.ctx.db, {
          projectId: project.id,
          number,
          queue: 'revisar',
          key: pr.headSha,
          headSha: pr.headSha,
          title: pr.title,
          url: pr.url,
          authorLogin: pr.authorLogin,
          reviewerId: user.id,
          status: 'waiting',
          priority: 0,
          trigger: 'manual',
          now
        })
    this.publish(job)
    this.dispatch()
    return job
  }

  // Resposta à pergunta de produto que o revisor achou no corpo do PR: a execução continua.
  answer(jobId: number, user: User, text: string): StoredJob {
    const job = getJob(this.ctx.db, jobId)
    if (!job?.question) throw new HttpError(404, 'Não há pergunta esperando resposta nesta execução.')
    if (job.reviewerId !== user.id) throw new HttpError(403, 'Quem responde é a pessoa em nome de quem o revisor trabalhou.')
    const updated = updateJob(this.ctx.db, job.id, { answer: text, status: 'waiting', attempts: 0, trigger: 'manual', error: null }, this.ctx.now()) as StoredJob
    this.publish(updated)
    this.dispatch()
    return updated
  }

  // "Tentar de novo" (o "esquecer" do script do Hermes): a entrada volta para a fila.
  retry(jobId: number, user: User): StoredJob {
    const job = getJob(this.ctx.db, jobId)
    if (!job) throw new HttpError(404, 'Execução não encontrada.')
    if (job.queue === 'assinatura') throw new HttpError(400, 'A limpeza de assinatura roda sozinha.')
    if (job.status === 'running') throw new HttpError(409, 'Esta execução está rodando.')
    if (job.reviewerId !== user.id && user.role !== 'admin') throw new HttpError(403, 'Só a pessoa do revisor (ou um administrador) pede de novo.')
    const updated = updateJob(this.ctx.db, job.id, { status: 'waiting', attempts: 0, trigger: 'manual', error: null }, this.ctx.now()) as StoredJob
    this.publish(updated)
    this.dispatch()
    return updated
  }

  // ── Execução ──────────────────────────────────────────────────────────────────────────────

  private fail(job: StoredJob, error: string, final = false): void {
    const current = getJob(this.ctx.db, job.id) ?? job
    const attempts = current.attempts + 1
    const giveUp = final || attempts >= MAX_ATTEMPTS
    this.publish(updateJob(this.ctx.db, job.id, { status: giveUp ? 'failed' : 'waiting', attempts, error }, this.ctx.now()))
    void this.trackStreak(job.reviewerId, error)
  }

  private skip(job: StoredJob, reason: string): void {
    this.publish(updateJob(this.ctx.db, job.id, { status: 'skipped', error: reason }, this.ctx.now()))
  }

  private async execute(job: StoredJob): Promise<void> {
    const project = getProject(this.ctx.db, job.projectId)
    const actor = job.reviewerId ? getUser(this.ctx.db, job.reviewerId) : null
    const repo = project ? parseGitHubRepo(project.repoUrl) : null
    if (!project || !actor || !repo) return this.fail(job, 'Projeto ou pessoa não encontrados.', true)
    const account = this.clientFor(actor)
    if (!account) return this.fail(job, `${firstName(actor)} precisa conectar o GitHub em "Minhas IAs".`, true)
    if (actor.reviewMode === 'off') return this.skip(job, 'O revisor desta pessoa está desligado.')
    const disabled = agentsDisabledReason(this.ctx)
    if (disabled) return this.fail(job, disabled, true)
    this.publish(updateJob(this.ctx.db, job.id, { status: 'running', error: null }, this.ctx.now()))

    const { client, token } = account
    const pr = await client.getPull(repo, job.number)
    if (pr.state !== 'open') return this.skip(job, 'O PR foi fechado ou mesclado.')
    if (['revisar', 'adiantar', 'retestar'].includes(job.queue) && pr.headSha !== job.headSha) {
      return this.skip(job, 'Chegou um commit novo: a próxima volta revisa o topo atual.')
    }
    const sha = pr.headSha
    if (sha !== job.headSha) updateJob(this.ctx.db, job.id, { headSha: sha }, this.ctx.now())

    // O espelho busca o commit do PR (e os dos outros PRs do mesmo autor, para a regra 10).
    const mirror = projectPath(this.ctx, project)
    await this.ctx.git.fetch(mirror)
    const fetched = await this.ctx.git.fetchPull(mirror, job.number)
    if (fetched !== sha) return this.fail(job, 'O espelho ainda não tem o topo do PR; tento de novo.')
    const open = await client.listOpenPullRequests(repo).catch(() => [])
    const siblings = open.filter((other) => other.authorLogin === pr.authorLogin && other.number !== pr.number)
    for (const other of siblings) await this.ctx.git.fetchPull(mirror, other.number).catch(() => '')

    const fork = pr.headRepo !== null && pr.headRepo.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
    const isAuthor = pr.authorLogin.toLowerCase() === account.login.toLowerCase()
    const canWrite = !fork && actor.reviewMode !== 'comment' && ['revisar', 'corrigir', 'conflito'].includes(job.queue)
    const mode = canWrite ? (actor.reviewMode === 'full' ? 'full' : 'fix') : 'comment'
    const checkout = await this.ctx.agents.prepareReviewCheckout({ user: actor, project, mirrorPath: mirror, number: job.number, sha })
    const settings = getReviewSettings(this.ctx.db, project.id)
    const memory = carregarMemoria(this.ctx.db, project.id, job.number)
    const reviews = await client.listReviews(repo, job.number)

    const message = await this.material({ job, project, repo, client, pr, sha, siblings, fork, mirror, reviews, memory })
    const chat = insertChat(this.ctx.db, {
      taskId: null,
      userId: actor.id,
      provider: 'claude',
      permissionMode: 'auto',
      branch: reviewBranch(job.number),
      cwd: checkout,
      origin: 'review',
      // A equipe acompanha o revisor trabalhando (o resultado vai para o GitHub de qualquer forma).
      shared: true,
      title: `${job.queue.toUpperCase()} · PR #${job.number} · ${pr.title}`.slice(0, 120),
      policy: { tools: REVIEWER_TOOLS, roots: [checkout] },
      instructions: reviewerInstructions({ actor, login: account.login, mode, rules: settings.rules }),
      now: this.ctx.now()
    })
    this.manager.publish(chat)
    this.publish(updateJob(this.ctx.db, job.id, { chatId: chat.id }, this.ctx.now()))

    const limits = { inactivityMs: this.options.inactivityMs ?? 30 * 60 * 1000, maxMs: this.options.maxMs ?? 2 * 60 * 60 * 1000 }
    let turn = await this.manager.runTurn(chat, message, limits)
    let result: ReviewerResult | null = null
    let log = { head: sha, commits: [] as { sha: string; message: string; files: string[] }[] }
    // Até duas voltas de correção: formato da resposta, portão das revisões e dos commits.
    for (let round = 0; round < 3; round++) {
      if (turn.error) return this.fail(job, turn.error)
      result = parseReviewerResult(turn.text)
      log = await this.ctx.agents.branchLog({ user: actor, path: checkout, from: sha })
      const problems = result
        ? this.check({ job, result, log, sha, canWrite, isAuthor, mode, memory })
        : ['A resposta não veio no formato pedido: responda SOMENTE com o bloco ```json.']
      if (problems.length === 0) break
      if (round === 2) return this.fail(job, `O portão recusou a publicação: ${problems.join(' ')}`)
      turn = await this.manager.runTurn(
        chat,
        `O portão do Harpia recusou a publicação. Corrija e responda de novo só com o JSON completo (commits ainda não enviados podem ser refeitos localmente):\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
        limits
      )
    }
    if (!result) return this.fail(job, 'O revisor não devolveu a resposta no formato esperado.')

    const commits = canWrite ? log.commits : []
    const finalSha = commits.length > 0 ? log.head : sha
    const urls: string[] = []
    const reviewsToPublish = result.revisoes.map((review) => ({ ...review, commit: commits.length > 0 ? review.commit : ('inicial' as const) }))

    // 1. Análise presa ao commit do PR, antes de qualquer correção.
    for (const review of reviewsToPublish.filter((item) => item.commit === 'inicial')) {
      urls.push(await this.publishReview({ job, project, repo, client, sha, review }))
    }
    // 2. Correções: push normal (fast-forward) com o token de quem revisa. Nunca --force.
    let pushedSha: string | null = null
    if (commits.length > 0) {
      const latest = await client.getPull(repo, job.number)
      if (latest.headSha !== sha) return this.fail(job, 'A branch do PR andou durante a revisão; recomeço a partir do topo novo.')
      const bundle = await this.ctx.agents.exportBranch({ user: actor, path: checkout, branch: reviewBranch(job.number) })
      await this.ctx.git.importBundleAs(mirror, bundle, reviewBranch(job.number), pr.headRef)
      try {
        await this.ctx.git.push(mirror, project.repoUrl, pr.headRef, token)
      } catch (error) {
        return this.fail(job, `O GitHub recusou o push (a branch andou?): ${(error as Error).message.slice(0, 200)}`)
      }
      pushedSha = finalSha
      await this.waitForHead(client, repo, job.number, finalSha)
    }
    // 3. Revisão das correções e aprovação, presas ao commit final.
    for (const review of reviewsToPublish.filter((item) => item.commit === 'final')) {
      urls.push(await this.publishReview({ job, project, repo, client, sha: finalSha, review }))
    }

    // Rascunho: trava quando pede alterações; destrava só o que o próprio revisor travou.
    const flags = getFlags(this.ctx.db, project.id, job.number)
    try {
      if (result.rascunho === 'travar' && !pr.draft && !isAuthor) {
        await client.setDraft(pr.nodeId, true)
        setFlag(this.ctx.db, project.id, job.number, 'drafted_by_reviewer', true)
      } else if (result.rascunho === 'destravar' && flags.draftedByReviewer) {
        await client.setDraft(pr.nodeId, false)
        setFlag(this.ctx.db, project.id, job.number, 'drafted_by_reviewer', false)
      }
    } catch {
      // Sem permissão para mudar o rascunho: a revisão já está publicada.
    }

    // Memória por achado e lições do projeto.
    const now = this.ctx.now()
    const lastEvent = result.revisoes.at(-1)?.evento ?? null
    let saved = memory
    try {
      saved = aplicarRodada(memory, result.achados, { sha: finalSha, em: now.toISOString(), evento: lastEvent, resumo: result.resultado })
      salvarMemoria(this.ctx.db, project.id, saved, now)
    } catch {
      // Achado com id inválido: a publicação vale, a memória fica como estava.
    }
    for (const lesson of result.licoes) {
      registrarLicao(this.ctx.db, { projectId: project.id, text: lesson, number: job.number, author: pr.authorLogin, now })
    }

    const openFindings = saved.achados.filter((achado) => achado.status === 'aberto')
    const counts: PrReviewCounts = {
      critical: openFindings.filter((achado) => achado.gravidade === 'bloqueia').length,
      warning: openFindings.filter((achado) => achado.gravidade === 'nao-bloqueia').length,
      suggestion: 0
    }
    if (result.estado === 'falhou') {
      this.fail(job, result.motivo || 'O revisor não conseguiu terminar (veja a conversa).')
      updateJob(this.ctx.db, job.id, { line: result.resultado || null, pushedSha, reviewUrl: urls.at(-1) ?? null }, now)
      return
    }
    const done = updateJob(
      this.ctx.db,
      job.id,
      {
        status: 'posted',
        verdict: verdictOf(result),
        counts,
        summary: result.resultado || null,
        line: result.resultado || null,
        reviewUrl: urls.at(-1) ?? null,
        pushedSha,
        question: result.pergunta || null,
        error: null
      },
      now
    ) as StoredJob
    this.publish(done)
    void this.trackStreak(actor.id, null)
    if (result.pergunta) {
      await this.ctx.notifier.sendTo(
        actor.id,
        `❓ PR #${job.number} "${pr.title}"\n\n${result.pergunta}\n\nNão aprovei: responda em "Revisões" no Harpia para eu continuar.${this.ctx.notifier.link('/')}`
      )
    }
    if (urls.length > 0) this.recordOnTask(project, done)
  }

  // Confere a resposta antes de publicar qualquer coisa. Devolve os problemas (vazio = pode publicar).
  private check(input: {
    job: StoredJob
    result: ReviewerResult
    log: { head: string; commits: { sha: string; message: string; files: string[] }[] }
    sha: string
    canWrite: boolean
    isAuthor: boolean
    mode: 'full' | 'fix' | 'comment'
    memory: ReturnType<typeof carregarMemoria>
  }): string[] {
    const { job, result, log, sha, canWrite, isAuthor, mode, memory } = input
    const problems: string[] = []
    if (log.commits.length > 0 && !canWrite) {
      problems.push(`Nesta execução você não pode enviar commits: desfaça com \`git reset --hard ${sha.slice(0, 7)}\`.`)
    }
    problems.push(...validarCommits(log.commits))
    const finalSha = log.commits.length > 0 ? log.head : sha
    const onlyComment = ['adiantar', 'corrigir', 'conflito', 'retestar'].includes(job.queue)
    result.revisoes.forEach((review, i) => {
      const where = `revisão ${i + 1}`
      if (review.evento === 'APPROVE') {
        if (onlyComment) problems.push(`${where}: nesta fila a revisão é COMMENT (a decisão é de outra pessoa).`)
        else if (mode !== 'full') problems.push(`${where}: este revisor não aprova; use COMMENT ou REQUEST_CHANGES.`)
        else if (isAuthor) problems.push(`${where}: ninguém aprova o próprio PR.`)
        else if (result.pergunta) problems.push(`${where}: há uma pergunta de produto em aberto; não aprove antes da resposta.`)
      }
      if (review.evento === 'REQUEST_CHANGES' && (isAuthor || onlyComment)) problems.push(`${where}: use COMMENT nesta fila.`)
      const commit = review.commit === 'final' && log.commits.length > 0 ? finalSha : sha
      const errors = validarRevisao({
        sha: commit,
        evento: review.evento,
        corpo: review.corpo,
        comentarios: review.comentarios as ReviewComment[],
        memoria: memory,
        achadosDaRodada: result.achados
      })
      problems.push(...errors.map((error) => `${where}: ${error}`))
    })
    try {
      aplicarRodada(memory, result.achados, { sha: finalSha, em: new Date().toISOString(), evento: null, resumo: '' })
    } catch (error) {
      problems.push(`achados: ${(error as Error).message}`)
    }
    return problems
  }

  // Publica uma revisão presa a um commit: confere o topo (SHA_DIVERGENTE), move para o corpo os
  // comentários fora do diff e, se o GitHub recusar os comentários em linha, publica sem eles.
  private async publishReview(input: {
    job: StoredJob
    project: Project
    repo: GitHubRepo
    client: GitHubClient
    sha: string
    review: ReviewerResult['revisoes'][number]
  }): Promise<string> {
    const { job, project, repo, client, sha, review } = input
    const current = await client.getPull(repo, job.number)
    if (current.headSha !== sha) throw new Error(`SHA_DIVERGENTE: a revisão é do ${sha.slice(0, 7)}, o topo atual é ${current.headSha.slice(0, 7)}.`)
    const map = mapaDoDiff(await client.listPullFiles(repo, job.number).catch(() => []))
    const { aceitos, fora } = separarComentarios(review.comentarios as ReviewComment[], map)
    const extra = (items: ReviewComment[]) => (items.length ? `\n\n${items.map((item) => `- \`${item.path}:${item.line}\` — ${item.body}`).join('\n')}` : '')
    let published: { id: number; url: string }
    try {
      published = await client.createReview(repo, job.number, { commitId: sha, event: review.evento, body: maskSecrets(review.corpo + extra(fora)), comments: aceitos })
    } catch (error) {
      if (aceitos.length === 0) throw error
      published = await client.createReview(repo, job.number, {
        commitId: sha,
        event: review.evento,
        body: maskSecrets(review.corpo + extra([...fora, ...aceitos])),
        comments: []
      })
    }
    recordPublished(this.ctx.db, { reviewId: published.id, projectId: project.id, number: job.number, jobId: job.id, now: this.ctx.now() })
    return published.url
  }

  private async waitForHead(client: GitHubClient, repo: GitHubRepo, number: number, sha: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const pr = await client.getPull(repo, number).catch(() => null)
      if (pr?.headSha === sha) return
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  // Tudo o que o revisor recebe na mensagem (a linha de entrada no formato do Hermes vem primeiro).
  private async material(input: {
    job: StoredJob
    project: Project
    repo: GitHubRepo
    client: GitHubClient
    pr: PullDetail
    sha: string
    siblings: { number: number; title: string }[]
    fork: boolean
    mirror: string
    reviews: PullReviewInfo[]
    memory: ReturnType<typeof carregarMemoria>
  }): Promise<string> {
    const { job, project, repo, client, pr, sha, siblings, fork, mirror, reviews, memory } = input
    const reviewedBefore = lastHandledSha(this.ctx.db, project.id, job.number, job.queue === 'adiantar' ? ['adiantar'] : ['revisar'])
    const checks = await client.listCheckRuns(repo, sha).catch(() => [])
    const mainSha = await client.getBranchSha(repo, pr.baseRef).catch(() => '')
    const humanReview = job.queue === 'corrigir' ? reviews.find((review) => `review:${review.id}` === job.triggerKey) : undefined
    const files = parseDiff(await this.ctx.git.diff(mirror, pr.baseRef, sha).catch(() => ''))
    const fitted = fitDiff(files)
    const lines: string[] = [
      entryLine({
        queue: job.queue,
        number: job.number,
        sha,
        title: pr.title,
        author: pr.authorLogin,
        branch: pr.headRef,
        draft: pr.draft,
        attempts: job.attempts,
        reviewedBefore: reviewedBefore === sha ? null : reviewedBefore,
        mainSha,
        approved: isApproved(reviews),
        impediment: fork ? 'fork' : '-',
        reviewId: humanReview?.id,
        reviewState: humanReview?.state,
        reviewAt: humanReview?.submittedAt
      }),
      '',
      `## PR #${job.number}`,
      `${pr.url} · autor @${pr.authorLogin} · branch \`${pr.headRef}\` → \`${pr.baseRef}\` · topo \`${sha}\`${pr.draft ? ' · rascunho' : ''}`,
      '<pr_nao_confiavel>',
      `Título: ${pr.title}`,
      `Corpo:\n${maskSecrets(pr.body.trim()).slice(0, 12000) || '(vazio)'}`,
      '</pr_nao_confiavel>',
      '',
      `## Diff (\`git diff origin/${pr.baseRef}...HEAD\` na pasta atual)`,
      '```diff',
      maskSecrets(fitted.text),
      '```'
    ]
    if (fitted.omitted.length) lines.push(`Ficaram fora por tamanho (veja na pasta): ${fitted.omitted.join(', ')}`)
    lines.push(
      '',
      '## Estado no GitHub',
      `- Mesclável: ${pr.mergeableState}${pr.mergeable === false ? ' (em conflito)' : ''}; aprovado: ${isApproved(reviews) ? 'sim' : 'não'}; topo da ${pr.baseRef}: \`${mainSha.slice(0, 7) || '?'}\``,
      `- CI no \`${sha.slice(0, 7)}\`: ${
        checks.length
          ? checks
              .map((check) => {
                const seconds =
                  check.startedAt && check.completedAt ? Math.round((new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000) : null
                return `${check.name}: ${check.conclusion ?? check.status}${seconds !== null ? ` (${seconds}s)` : ''}`
              })
              .join('; ')
          : 'nenhum check'
      }`,
      `- Revisões no PR: ${
        reviews.length
          ? reviews.map((review) => `@${review.login} ${review.state} em ${review.submittedAt?.slice(0, 16) ?? '?'} no ${review.commitId?.slice(0, 7) ?? '?'}`).join('; ')
          : 'nenhuma'
      }`
    )
    if (siblings.length) {
      lines.push(
        '',
        `## Outros PRs abertos de @${pr.authorLogin} (regra 10: leia antes de mexer)`,
        ...siblings.map((other) => `- #${other.number} ${other.title} → \`refs/harpia/pull/${other.number}\``)
      )
    }
    if (humanReview) {
      const comments = await client.listReviewComments(repo, job.number, humanReview.id).catch(() => [])
      lines.push(
        '',
        `## Revisão de @${humanReview.login} (${humanReview.state}, ${humanReview.submittedAt ?? '?'})`,
        '<revisao_de_pessoa>',
        humanReview.body || '(sem texto)',
        ...comments.map((comment) => `- \`${comment.path}:${comment.line ?? '?'}\` — ${comment.body}\n  trecho:\n${comment.diffHunk.split('\n').slice(-6).join('\n')}`),
        '</revisao_de_pessoa>'
      )
    }
    lines.push(
      '',
      '## Memória deste PR (achados das rodadas anteriores)',
      memory.achados.length
        ? memory.achados
            .map((achado) => `- ${achado.id} [${achado.gravidade}, ${achado.status}] ${achado.resumo}${achado.arquivo ? ` (\`${achado.arquivo}${achado.linha ? `:${achado.linha}` : ''}\`)` : ''}`)
            .join('\n')
        : '(nenhum achado ainda)'
    )
    const lessons = listarLicoes(this.ctx.db, project.id)
    if (lessons.length) lines.push('', '## Lições do projeto (leia por alto)', ...lessons)
    const projectMemory = getMemory(this.ctx.db, project.id).body
    if (projectMemory) lines.push('', '## Memória do projeto (escrita pela equipe)', projectMemory)
    if (job.question && job.answer) {
      lines.push('', '## Resposta à sua pergunta', `Você perguntou: ${job.question}`, `Resposta: ${job.answer}`)
    }
    lines.push('', `Siga a rotina ${job.queue.toUpperCase()} das regras do projeto, do início ao fim, e responda só com o JSON.`)
    return lines.join('\n')
  }

  // Revisão de um PR aberto pelo Harpia entra no histórico da task.
  private recordOnTask(project: Project, job: StoredJob): void {
    const row = this.ctx.db
      .prepare('SELECT p.task_id FROM pull_requests p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ? AND p.number = ? LIMIT 1')
      .get(project.id, job.number) as { task_id: number } | undefined
    if (!row) return
    const event = insertEvent(this.ctx.db, {
      taskId: row.task_id,
      actorId: null,
      type: 'pr_reviewed',
      data: { number: job.number, queue: job.queue, verdict: job.verdict, counts: job.counts, url: job.reviewUrl, reviewerId: job.reviewerId, line: job.line },
      now: this.ctx.now()
    })
    publishTaskChange(this.ctx, row.task_id, [event])
  }

  // Vigia do revisor (port do vigia_cron_revisor.py): avisa quando o revisor de uma pessoa falha
  // 3 vezes seguidas pelo mesmo motivo, uma vez só, e quando volta ao normal.
  private async trackStreak(userId: number | null, error: string | null): Promise<void> {
    if (!userId) return
    const key = `review-streak:${userId}`
    const state = JSON.parse(getSetting(this.ctx.db, key) ?? '{"count":0,"reason":null,"alerted":false}') as {
      count: number
      reason: string | null
      alerted: boolean
    }
    const stable = (text: string | null) => (text ? text.replace(/\d+/g, 'N').slice(0, 160) : null)
    if (!error) {
      if (state.alerted) await this.ctx.notifier.sendTo(userId, `✅ O seu revisor de PRs voltou ao normal (estava falhando: ${state.reason}).`)
      setSetting(this.ctx.db, key, null)
      return
    }
    const sameReason = stable(state.reason) === stable(error)
    const next = { count: sameReason ? state.count + 1 : 1, reason: error, alerted: sameReason ? state.alerted : false }
    if (next.count >= STREAK_ALERT && !next.alerted) {
      next.alerted = true
      await this.ctx.notifier.sendTo(userId, `⚠️ O seu revisor de PRs falhou ${next.count} vezes seguidas: ${error}`)
    }
    setSetting(this.ctx.db, key, JSON.stringify(next))
  }

  private publish(job: StoredJob | null): void {
    if (job) this.ctx.hub.broadcast({ type: 'pr_review', review: publicJob(job) })
  }
}
