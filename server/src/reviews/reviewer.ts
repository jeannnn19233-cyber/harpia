import { VERDICT_LABELS, type PrReview, type Project, type User } from '../../../shared/types.ts'
import { agentsDisabledReason, publishTaskChange } from '../agents/workspace.ts'
import { findUserByGitHubLogin, getUser } from '../auth/users.ts'
import { READ_TOOLS } from '../automation/policy.ts'
import type { ChatManager } from '../chat/manager.ts'
import { insertChat } from '../chat/store.ts'
import type { AppContext } from '../context.ts'
import { parseGitHubRepo, type GitHubRepo, type OpenPullRequest } from '../github/client.ts'
import { HttpError } from '../http/errors.ts'
import { getMemory } from '../memory/store.ts'
import { projectPath } from '../projects/routes.ts'
import { listProjects } from '../projects/store.ts'
import { insertEvent } from '../tasks/store.ts'
import { fitDiff, maskSecrets, parseDiff, scanSecrets } from './diff.ts'
import {
  countFindings,
  describeCounts,
  finalVerdict,
  inlineComment,
  parseReviewResult,
  reviewBody,
  reviewInstructions,
  reviewMessage,
  type ReviewFinding
} from './prompt.ts'
import { failRunningReviews, findReview, insertReview, listWaitingReviews, updateReview } from './store.ts'

export interface ReviewerOptions {
  // De quanto em quanto tempo o servidor olha os PRs abertos. 0 desliga o laço (testes).
  pollSeconds: number
  // Espera o PR ficar esse tempo sem commits novos antes de revisar (pushes seguidos viram uma revisão).
  settleSeconds: number
  maxConcurrent: number
  inactivityMs?: number
}

// Rótulo que tira um PR da revisão automática.
export const SKIP_LABEL = 'sem-revisao-ia'
// Limite de comentários nas linhas por revisão (o resto vai para o resumo).
const MAX_INLINE = 20

// Revisão automática dos PRs: o servidor detecta, sem IA, cada commit novo dos PRs abertos; a
// revisão roda no Claude do autor do PR, só lendo uma cópia do commit; o servidor confere a
// resposta e publica no GitHub (sempre como comentário) e no Telegram.
export class PrReviewer {
  private readonly ctx: AppContext
  private readonly manager: ChatManager
  private readonly options: ReviewerOptions
  private readonly running = new Map<number, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null

  constructor(ctx: AppContext, manager: ChatManager, options: ReviewerOptions) {
    this.ctx = ctx
    this.manager = manager
    this.options = options
  }

  start(): void {
    failRunningReviews(this.ctx.db, this.ctx.now())
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
      this.polling = this.pollAll().finally(() => {
        this.polling = null
      })
    }
    return this.polling
  }

  private async pollAll(): Promise<void> {
    for (const project of listProjects(this.ctx.db)) {
      const repo = parseGitHubRepo(project.repoUrl)
      if (!project.prReview || !repo || project.cloneStatus !== 'ready') continue
      let pulls: OpenPullRequest[]
      try {
        pulls = await this.ctx.github.listOpenPullRequests(repo)
      } catch {
        // GitHub fora do ar ou token sem permissão: tenta na próxima volta.
        continue
      }
      for (const pr of pulls) this.track(project, repo, pr)
    }
  }

  private track(project: Project, repo: GitHubRepo, pr: OpenPullRequest): void {
    if (pr.draft || pr.labels.includes(SKIP_LABEL) || !pr.headSha) return
    const now = this.ctx.now()
    // Commit novo antes de revisar o anterior: só o mais recente é revisado.
    for (const old of listWaitingReviews(this.ctx.db, project.id, pr.number)) {
      if (old.headSha !== pr.headSha) {
        this.publish(updateReview(this.ctx.db, old.id, { status: 'skipped', error: 'Chegou um commit novo antes da revisão.' }, now))
      }
    }
    let review = findReview(this.ctx.db, project.id, pr.number, pr.headSha)
    if (!review) {
      const author = findUserByGitHubLogin(this.ctx.db, pr.authorLogin)
      review = insertReview(this.ctx.db, {
        projectId: project.id,
        number: pr.number,
        headSha: pr.headSha,
        title: pr.title,
        url: pr.url,
        authorLogin: pr.authorLogin,
        reviewerId: author?.id ?? null,
        status: author ? 'waiting' : 'skipped',
        error: author
          ? null
          : `@${pr.authorLogin} não está ligado a ninguém da equipe no Harpia. Quem quiser pode pedir a revisão com a própria conta.`,
        trigger: 'auto',
        now
      })
      this.publish(review)
    }
    const settled = now.getTime() - new Date(review.createdAt).getTime() >= this.options.settleSeconds * 1000
    if (review.status === 'waiting' && settled) this.launch(review, project, repo, pr)
  }

  // "Revisar agora" com a conta de quem pediu (PR de fora da equipe, ou para revisar de novo).
  async requestReview(project: Project, number: number, user: User): Promise<PrReview> {
    const repo = parseGitHubRepo(project.repoUrl)
    if (!repo) throw new HttpError(400, 'O repositório deste projeto não é do GitHub.')
    const pr = (await this.ctx.github.listOpenPullRequests(repo)).find((item) => item.number === number)
    if (!pr) throw new HttpError(404, `O PR #${number} não está aberto no GitHub.`)
    const now = this.ctx.now()
    const existing = findReview(this.ctx.db, project.id, number, pr.headSha)
    if (existing && (existing.status === 'running' || this.running.has(existing.id))) {
      throw new HttpError(409, 'Este PR já está sendo revisado.')
    }
    const review = existing
      ? (updateReview(
          this.ctx.db,
          existing.id,
          { status: 'waiting', reviewerId: user.id, trigger: 'manual', error: null, title: pr.title },
          now
        ) as PrReview)
      : insertReview(this.ctx.db, {
          projectId: project.id,
          number,
          headSha: pr.headSha,
          title: pr.title,
          url: pr.url,
          authorLogin: pr.authorLogin,
          reviewerId: user.id,
          status: 'waiting',
          trigger: 'manual',
          now
        })
    this.publish(review)
    if (!this.launch(review, project, repo, pr)) {
      throw new HttpError(429, 'Muitas revisões rodando agora. Ela começa sozinha em alguns minutos.')
    }
    return review
  }

  private launch(review: PrReview, project: Project, repo: GitHubRepo, pr: OpenPullRequest): boolean {
    if (this.running.has(review.id)) return true
    if (this.running.size >= this.options.maxConcurrent) return false
    const promise = this.execute(review, project, repo, pr)
      .catch((error) => this.fail(review, (error as Error).message))
      .finally(() => this.running.delete(review.id))
    this.running.set(review.id, promise)
    return true
  }

  private fail(review: PrReview, error: string): void {
    this.publish(updateReview(this.ctx.db, review.id, { status: 'failed', error }, this.ctx.now()))
  }

  private async execute(review: PrReview, project: Project, repo: GitHubRepo, pr: OpenPullRequest): Promise<void> {
    const reviewer = review.reviewerId ? getUser(this.ctx.db, review.reviewerId) : null
    if (!reviewer) return this.fail(review, 'Ninguém da equipe para revisar com o próprio Claude.')
    const disabled = agentsDisabledReason(this.ctx)
    if (disabled) return this.fail(review, disabled)
    this.publish(updateReview(this.ctx.db, review.id, { status: 'running', error: null }, this.ctx.now()))

    // O espelho busca o commit do PR e a branch de destino atualizada (o token fica no servidor).
    const mirror = projectPath(this.ctx, project)
    await this.ctx.git.fetch(mirror)
    const sha = await this.ctx.git.fetchPull(mirror, pr.number)
    if (sha !== review.headSha) {
      this.publish(updateReview(this.ctx.db, review.id, { status: 'skipped', error: 'Chegou um commit novo antes da revisão.' }, this.ctx.now()))
      return
    }
    const files = parseDiff(await this.ctx.git.diff(mirror, pr.baseRef, sha))
    if (files.length === 0) {
      this.publish(updateReview(this.ctx.db, review.id, { status: 'skipped', error: 'O PR não tem alterações em relação à base.' }, this.ctx.now()))
      return
    }
    const secrets = scanSecrets(files)
    const fitted = fitDiff(files)
    const checkout = await this.ctx.agents.prepareReviewCheckout({ user: reviewer, project, mirrorPath: mirror, number: pr.number, sha })

    const chat = insertChat(this.ctx.db, {
      taskId: null,
      userId: reviewer.id,
      provider: 'claude',
      permissionMode: 'auto',
      branch: null,
      cwd: checkout,
      origin: 'review',
      // A equipe acompanha a revisão ao vivo (o resultado vai para o GitHub de qualquer forma).
      shared: true,
      title: `Revisão do PR #${pr.number} · ${pr.title}`.slice(0, 120),
      policy: { tools: READ_TOOLS, roots: [checkout] },
      instructions: reviewInstructions(getMemory(this.ctx.db, project.id).body),
      now: this.ctx.now()
    })
    this.manager.publish(chat)
    this.publish(updateReview(this.ctx.db, review.id, { chatId: chat.id }, this.ctx.now()))

    const message = reviewMessage({
      repo: `${repo.owner}/${repo.name}`,
      number: pr.number,
      title: pr.title,
      body: maskSecrets(pr.body),
      author: pr.authorLogin,
      base: pr.baseRef,
      sha,
      diff: maskSecrets(fitted.text),
      omitted: fitted.omitted,
      secrets
    })
    const limits = { inactivityMs: this.options.inactivityMs }
    let turn = await this.manager.runTurn(chat, message, limits)
    if (turn.error) return this.fail(review, turn.error)
    let result = parseReviewResult(turn.text)
    if (!result) {
      // Uma segunda chance para o formato, como no Hermes (falha fechada se não vier).
      turn = await this.manager.runTurn(
        chat,
        'Sua resposta não veio no formato pedido. Responda agora SOMENTE com o bloco ```json da revisão, sem mais nada.',
        limits
      )
      if (turn.error) return this.fail(review, turn.error)
      result = parseReviewResult(turn.text)
    }
    if (!result) return this.fail(review, 'O revisor não devolveu a revisão no formato esperado.')

    // Segredos achados pela varredura entram como críticos, mesmo que o agente não tenha visto.
    const findings: ReviewFinding[] = [...result.findings]
    for (const secret of secrets) {
      if (findings.some((finding) => finding.path === secret.path && finding.line === secret.line)) continue
      findings.unshift({
        path: secret.path,
        line: secret.line,
        severity: 'critical',
        title: `Possível segredo no código (${secret.kind})`,
        body: 'Esta linha adiciona algo com cara de segredo. Se for real, revogue agora: ele já está no histórico do git.',
        fix: 'Mova o valor para uma variável de ambiente e gere um segredo novo.'
      })
    }
    const counts = countFindings(findings)
    const verdict = finalVerdict(result, counts)
    const valid = new Map(files.map((file) => [file.path, file.lines]))
    const inline: ReviewFinding[] = []
    const general: ReviewFinding[] = []
    for (const finding of findings) {
      if (finding.line && valid.get(finding.path)?.has(finding.line) && inline.length < MAX_INLINE) inline.push(finding)
      else general.push(finding)
    }
    const reviewerName = reviewer.githubLogin ? `@${reviewer.githubLogin}` : reviewer.name.split(' ')[0]
    const body = (withInline: boolean) =>
      maskSecrets(
        reviewBody({
          verdict,
          counts,
          summary: result.summary,
          inline: withInline ? inline : [],
          general: withInline ? general : findings,
          reviewer: reviewerName,
          sha
        })
      )
    let posted: { url: string }
    try {
      posted = await this.ctx.github.createReview(repo, pr.number, {
        commitId: sha,
        body: body(true),
        comments: inline.map((finding) => ({ path: finding.path, line: finding.line as number, body: maskSecrets(inlineComment(finding)) }))
      })
    } catch {
      // O GitHub recusa a revisão inteira se uma linha não estiver no diff: manda tudo no resumo.
      posted = await this.ctx.github.createReview(repo, pr.number, { commitId: sha, body: body(false), comments: [] })
    }

    const done = updateReview(
      this.ctx.db,
      review.id,
      { status: 'posted', verdict, counts, summary: maskSecrets(result.summary), reviewUrl: posted.url, error: null },
      this.ctx.now()
    ) as PrReview
    this.publish(done)
    this.recordOnTask(project, done)

    const line = `🔎 Revisão do PR #${pr.number} "${pr.title}"\nVeredito da IA: ${VERDICT_LABELS[verdict]} · ${describeCounts(counts)}\n${posted.url}`
    const author = findUserByGitHubLogin(this.ctx.db, pr.authorLogin)
    for (const userId of new Set([author?.id, reviewer.id].filter((id): id is number => id !== undefined))) {
      await this.ctx.notifier.sendTo(userId, line)
    }
  }

  // Se o PR saiu de uma task do Harpia, a revisão entra no histórico da task.
  private recordOnTask(project: Project, review: PrReview): void {
    const row = this.ctx.db
      .prepare('SELECT p.task_id FROM pull_requests p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ? AND p.number = ? LIMIT 1')
      .get(project.id, review.number) as { task_id: number } | undefined
    if (!row) return
    const event = insertEvent(this.ctx.db, {
      taskId: row.task_id,
      actorId: null,
      type: 'pr_reviewed',
      data: { number: review.number, verdict: review.verdict, counts: review.counts, url: review.reviewUrl, reviewerId: review.reviewerId },
      now: this.ctx.now()
    })
    publishTaskChange(this.ctx, row.task_id, [event])
  }

  private publish(review: PrReview | null): void {
    if (review) this.ctx.hub.broadcast({ type: 'pr_review', review })
  }
}
