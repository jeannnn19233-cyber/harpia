import type { Routine, RoutineRun, User } from '../../../shared/types.ts'
import { agentsDisabledReason } from '../agents/workspace.ts'
import { getUser } from '../auth/users.ts'
import { WEB_TOOLS, WRITE_TOOLS, type AutomationPolicy } from '../automation/policy.ts'
import type { ChatManager } from '../chat/manager.ts'
import { insertChat } from '../chat/store.ts'
import type { AppContext } from '../context.ts'
import { HttpError } from '../http/errors.ts'
import { VAULT_FOLDER } from '../vault/paths.ts'
import { failureReason, isQuotaError, isSilent, routineMessage, routineSystemPrompt } from './prompt.ts'
import { graceMs, nextRun } from './schedule.ts'
import {
  claimSlot,
  getRoutine,
  insertRun,
  interruptRunningRuns,
  listDueRoutines,
  previousOutput,
  publicRoutine,
  updateRoutine,
  updateRun,
  type StoredRoutine
} from './store.ts'

export interface RoutineRunnerOptions {
  // De quanto em quanto tempo o agendador confere as rotinas. 0 desliga o laço (testes chamam tick()).
  tickSeconds: number
  // Execuções ao mesmo tempo no servidor todo (a VPS é dividida com o Clarumi).
  maxConcurrent: number
  inactivityMs?: number
  maxMs?: number
}

// Depois de tantas falhas seguidas, a rotina é pausada e a pessoa avisada.
const PAUSE_AFTER_FAILURES = 5
// Cota do Claude esgotada: espera esse tempo antes de tentar de novo.
const QUOTA_HOLD_MS = 60 * 60 * 1000

export function routineFolder(routine: Pick<Routine, 'id' | 'folder'>): string {
  return routine.folder === 'vault' ? VAULT_FOLDER : `rotinas/${routine.id}`
}

export function routinePolicy(routine: Pick<Routine, 'web'>, cwd: string): AutomationPolicy {
  return { tools: [...WRITE_TOOLS, ...(routine.web ? WEB_TOOLS : [])], roots: [cwd] }
}


// Agendador das rotinas: cada horário roda no máximo uma vez, cada execução é uma conversa nova no
// Claude da dona da rotina, e o resultado vai para o Telegram (ou fica só no Harpia).
export class RoutineRunner {
  private readonly ctx: AppContext
  private readonly manager: ChatManager
  private readonly options: RoutineRunnerOptions
  private readonly running = new Map<number, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking: Promise<void> | null = null

  constructor(ctx: AppContext, manager: ChatManager, options: RoutineRunnerOptions) {
    this.ctx = ctx
    this.manager = manager
    this.options = options
  }

  start(): void {
    interruptRunningRuns(this.ctx.db, this.ctx.now())
    if (this.options.tickSeconds > 0) {
      this.timer = setInterval(() => void this.tick(), this.options.tickSeconds * 1000)
      this.timer.unref()
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.ticking
    await this.idle()
  }

  // Espera as execuções em andamento terminarem.
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()])
  }

  isRunning(routineId: number): boolean {
    return this.running.has(routineId)
  }

  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.tickOnce().finally(() => {
        this.ticking = null
      })
    }
    return this.ticking
  }

  private async tickOnce(): Promise<void> {
    const now = this.ctx.now()
    for (const routine of listDueRoutines(this.ctx.db, now)) {
      if (this.running.has(routine.id)) continue
      if (this.running.size >= this.options.maxConcurrent) return
      const slot = routine.nextRunAt as string
      const following = nextRun(routine.schedule, routine.timezone, now)
      // Avança o horário ANTES de rodar: se o servidor cair no meio, este horário não roda de novo.
      if (!claimSlot(this.ctx.db, routine.id, slot, following?.toISOString() ?? null)) continue
      const late = now.getTime() - new Date(slot).getTime()
      if (late > graceMs(routine.schedule, routine.timezone, new Date(slot))) {
        const run = insertRun(this.ctx.db, {
          routineId: routine.id,
          scheduledFor: slot,
          trigger: 'schedule',
          status: 'skipped',
          error: 'Horário perdido: o servidor estava fora do ar.',
          now
        })
        this.publishRun(routine, run)
        this.publishRoutine(getRoutine(this.ctx.db, routine.id))
        continue
      }
      let run: RoutineRun
      try {
        run = insertRun(this.ctx.db, { routineId: routine.id, scheduledFor: slot, trigger: 'schedule', status: 'running', now })
      } catch {
        // Outro processo já registrou este horário.
        continue
      }
      this.launch(routine, run)
    }
  }

  // "Rodar agora": uma execução extra, que não gasta o próximo horário agendado.
  runNow(routine: StoredRoutine): RoutineRun {
    if (this.running.has(routine.id)) throw new HttpError(409, 'Esta rotina já está rodando.')
    if (this.running.size >= this.options.maxConcurrent) {
      throw new HttpError(429, 'Muitas rotinas rodando agora no servidor. Tente de novo em alguns minutos.')
    }
    const now = this.ctx.now()
    const run = insertRun(this.ctx.db, { routineId: routine.id, scheduledFor: now.toISOString(), trigger: 'manual', status: 'running', now })
    this.launch(routine, run)
    return run
  }

  private launch(routine: StoredRoutine, run: RoutineRun): void {
    this.publishRun(routine, run)
    const promise = this.execute(routine, run)
      .catch((error) => this.finish(routine, run, { status: 'failed', error: (error as Error).message }))
      .finally(() => this.running.delete(routine.id))
    this.running.set(routine.id, promise)
  }

  private async execute(routine: StoredRoutine, run: RoutineRun): Promise<void> {
    const owner = getUser(this.ctx.db, routine.userId)
    if (!owner) return this.finish(routine, run, { status: 'failed', error: 'Dona da rotina não encontrada.' })
    const disabled = agentsDisabledReason(this.ctx)
    if (disabled) return this.finish(routine, run, { status: 'failed', error: disabled })

    const cwd = await this.ctx.agents.prepareFolder(owner, routineFolder(routine))
    const now = this.ctx.now()
    const label = now.toLocaleString('pt-BR', {
      timeZone: routine.timezone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    const chat = insertChat(this.ctx.db, {
      taskId: null,
      userId: owner.id,
      provider: 'claude',
      permissionMode: 'auto',
      branch: null,
      cwd,
      model: routine.model,
      origin: 'routine',
      title: `${routine.name} · ${label}`,
      policy: routinePolicy(routine, cwd),
      instructions: routineSystemPrompt(routine, owner.name.split(' ')[0]),
      now
    })
    this.manager.publish(chat)
    this.publishRun(routine, updateRun(this.ctx.db, run.id, { chatId: chat.id }))

    const message = routineMessage({
      prompt: routine.prompt,
      now,
      timezone: routine.timezone,
      previous: routine.continuity ? previousOutput(this.ctx.db, routine.id, run.id) : null
    })
    const result = await this.manager.runTurn(chat, message, { inactivityMs: this.options.inactivityMs, maxMs: this.options.maxMs })

    if (result.error) return this.finish(routine, run, { status: 'failed', error: result.error, owner })
    const failure = failureReason(result.text)
    if (failure) return this.finish(routine, run, { status: 'failed', error: failure, output: result.text, owner })
    if (isSilent(result.text)) return this.finish(routine, run, { status: 'silent', output: result.text, owner })

    let delivered = false
    if (routine.deliver === 'telegram') {
      delivered = await this.ctx.notifier.sendTo(owner.id, `⏰ ${routine.name}\n\n${result.text}`)
    }
    return this.finish(routine, run, { status: 'ok', output: result.text, delivered, owner })
  }

  private async finish(
    routine: StoredRoutine,
    run: RoutineRun,
    result: { status: RoutineRun['status']; error?: string; output?: string; delivered?: boolean; owner?: User }
  ): Promise<void> {
    const now = this.ctx.now()
    this.publishRun(
      routine,
      updateRun(this.ctx.db, run.id, {
        status: result.status,
        error: result.error ?? null,
        output: result.output ?? null,
        delivered: result.delivered ?? false,
        finishedAt: now.toISOString()
      })
    )
    const current = getRoutine(this.ctx.db, routine.id)
    if (!current) return
    const failed = result.status === 'failed'
    const streak = failed ? current.failureStreak + 1 : 0
    const quota = failed && isQuotaError(result.error ?? '')
    const fields: Parameters<typeof updateRoutine>[2] = {
      lastRunAt: run.startedAt,
      lastStatus: result.status,
      lastError: result.error ?? null,
      failureStreak: streak,
      holdUntil: quota ? new Date(now.getTime() + QUOTA_HOLD_MS).toISOString() : null
    }
    const pause = failed && !quota && streak >= PAUSE_AFTER_FAILURES
    if (pause) fields.enabled = false
    this.publishRoutine(updateRoutine(this.ctx.db, routine.id, fields, now))

    // Avisa a falha uma vez por motivo (não a cada execução), e sempre quando pausa.
    if (!failed) return
    const owner = result.owner ?? getUser(this.ctx.db, routine.userId)
    if (!owner) return
    if (quota && current.holdUntil === null) {
      await this.ctx.notifier.sendTo(
        owner.id,
        `⏰ ${routine.name}\nA cota da sua assinatura do Claude acabou. A rotina tenta de novo em 1 hora.`
      )
    } else if (pause) {
      await this.ctx.notifier.sendTo(
        owner.id,
        `⏰ ${routine.name}\nFalhou ${streak} vezes seguidas e foi pausada. Último erro: ${result.error}\nRetome em "Rotinas" no Harpia.`
      )
    } else if (!quota && (streak === 1 || current.lastError !== result.error)) {
      await this.ctx.notifier.sendTo(owner.id, `⏰ ${routine.name}\nA rotina falhou: ${result.error}`)
    }
  }

  publishRoutine(routine: StoredRoutine | null): void {
    if (!routine) return
    this.ctx.hub.broadcastWhere({ type: 'routine', routine: publicRoutine(routine) }, (userId) => userId === routine.userId)
  }

  private publishRun(routine: StoredRoutine, run: RoutineRun | null): void {
    if (!run) return
    this.ctx.hub.broadcastWhere({ type: 'routine_run', run }, (userId) => userId === routine.userId)
  }
}
