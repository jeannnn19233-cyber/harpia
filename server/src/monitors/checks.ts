import { Cron } from 'croner'
import { SEGREDO } from '../reviews/gate.ts'
import type { CoolifyDeployment, CoolifyExecution, CoolifyTask, HttpProbe } from './coolify.ts'

// Regras dos vigias, sem rede (port do vigia_deploy_clarumi.py e do vigia_crons_coolify_clarumi.py
// do Hermes). Quem chama busca os dados no Coolify e no GitHub; aqui só se decide o que avisar.

export function hora(ts: string | Date | null, timezone: string): string {
  if (!ts) return '—'
  const date = typeof ts === 'string' ? new Date(ts) : ts
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(date)
    .replace(',', '')
}

// "PR #123" quando a mensagem do merge cita o PR; senão o começo da mensagem; senão o hash.
export function mergeTitle(message: string | null, sha: string | null): string {
  const first = message?.split('\n')[0]?.trim() ?? ''
  const pr = /#(\d+)/.exec(first)
  if (pr) return `PR #${pr[1]}`
  return first ? first.slice(0, 60) : (sha ?? '').slice(0, 7)
}

const SECRET_WORDS = /(password|secret|token|apikey|api_key|x-access-token|authorization)/i

export function errorLines(logs: string[] | null): string[] | null {
  if (!logs) return null
  return logs
    .map((line) => line.replace(/\n/g, ' '))
    .filter((line) => /error|failed|exit code|ERR!/i.test(line) && !SECRET_WORDS.test(line) && !SEGREDO.test(line))
    .map((line) => line.slice(0, 220))
    .slice(-6)
}

// ── Deploy ─────────────────────────────────────────────────────────────────────────────────────

export interface DeployState {
  // Último deploy já relatado (id do Coolify).
  ultimo: number
  // Avisos que não se repetem (deploy preso, main sem deploy).
  avisados: string[]
}

const CLOSED = ['finished', 'failed', 'cancelled-by-user']
const ACTIVE = ['queued', 'in_progress']

export interface DeployRoundInput {
  // Mais novos primeiro, só os da branch principal (sem os de preview de PR).
  deployments: CoolifyDeployment[]
  state: DeployState | null
  now: Date
  timezone: string
  // Problemas do que está no ar (aplicação saudável, URLs de saúde).
  checkLive: () => Promise<string[]>
  // Execuções de tarefas agendadas que não deram certo desde um instante.
  failedTasksSince: (since: string) => Promise<{ name: string; status: string; message: string | null }[]>
  // Topo da branch principal no GitHub (null quando não deu para ler).
  mainHead: () => Promise<{ sha: string; message: string; date: string } | null>
  siteLabel: string
}

export async function deployRound(input: DeployRoundInput): Promise<{ state: DeployState; reports: string[] }> {
  const { deployments: deps, now, timezone } = input
  const when = (ts: string | null) => hora(ts, timezone)
  if (!input.state) {
    // Primeira volta: marca o ponto de partida sem relatar o passado.
    const closed = deps.filter((dep) => CLOSED.includes(dep.status)).map((dep) => dep.id)
    return { state: { ultimo: closed.length ? Math.max(...closed) : 0, avisados: [] }, reports: [] }
  }
  const state: DeployState = { ultimo: input.state.ultimo, avisados: [...input.state.avisados] }
  const reports: string[] = []
  const fresh = deps.filter((dep) => dep.id > state.ultimo && !ACTIVE.includes(dep.status)).sort((a, b) => a.id - b.id)
  let lastSuccess: CoolifyDeployment | null = null
  for (const dep of fresh) {
    const name = mergeTitle(dep.commitMessage, dep.commit)
    const sha = (dep.commit ?? '').slice(0, 7)
    if (dep.status === 'finished') lastSuccess = dep
    else {
      const errors = errorLines(dep.logs)
      reports.push(
        `❌ Deploy #${dep.id} (${name}, \`${sha}\`) **${dep.status === 'failed' ? 'falhou' : 'foi cancelado'}** — ${when(dep.createdAt)} → ${when(dep.updatedAt)}.\n` +
          (errors === null
            ? '  · (o token do Harpia não lê o log; veja no Coolify)'
            : errors.length
              ? errors.map((line) => `  · ${line}`).join('\n')
              : '  · (log sem linha de erro legível)')
      )
    }
    state.ultimo = Math.max(state.ultimo, dep.id)
  }

  if (lastSuccess) {
    // Outro deploy em andamento troca os containers e derruba a aplicação por um minuto:
    // conferir agora daria alarme falso. Espera a próxima volta.
    if (deps.some((dep) => ACTIVE.includes(dep.status))) {
      state.ultimo = lastSuccess.id - 1
      return { state, reports }
    }
    const name = mergeTitle(lastSuccess.commitMessage, lastSuccess.commit)
    const sha = (lastSuccess.commit ?? '').slice(0, 7)
    const newest = deps.find((dep) => dep.status === 'finished')
    const problems = newest?.id === lastSuccess.id ? await input.checkLive() : []
    if (problems.length) {
      reports.push(`⚠️ Deploy #${lastSuccess.id} (${name}, \`${sha}\`) terminou às ${when(lastSuccess.updatedAt)}, mas:\n${problems.map((item) => `  · ${item}`).join('\n')}`)
    } else {
      reports.push(
        `✅ Deploy #${lastSuccess.id} (${name}, \`${sha}\`) concluído — ${when(lastSuccess.createdAt)} → ${when(lastSuccess.updatedAt)}. ${input.siteLabel}`
      )
    }
    for (const task of await input.failedTasksSince(lastSuccess.updatedAt)) {
      reports.push(`⚠️ Tarefa agendada \`${task.name}\` depois do deploy: ${task.status}${task.message ? ` — ${task.message.slice(0, 140)}` : ''}`)
    }
  }

  // Deploy preso: em andamento há mais de 20 minutos (avisa uma vez).
  for (const dep of deps) {
    if (dep.status !== 'in_progress') continue
    const key = `preso-${dep.id}`
    if (now.getTime() - new Date(dep.createdAt).getTime() > 20 * 60 * 1000 && !state.avisados.includes(key)) {
      reports.push(`⏳ Deploy #${dep.id} (\`${(dep.commit ?? '').slice(0, 7)}\`) em andamento desde ${when(dep.createdAt)}, há mais de 20 min.`)
      state.avisados.push(key)
    }
  }

  // Merge na branch principal sem deploy: o webhook pode ter falhado (avisa uma vez).
  const main = await input.mainHead().catch(() => null)
  if (main?.sha && main.date) {
    const key = `sem-deploy-${main.sha}`
    const hasDeploy = deps.some((dep) => dep.commit === main.sha)
    if (!hasDeploy && now.getTime() - new Date(main.date).getTime() > 10 * 60 * 1000 && !state.avisados.includes(key)) {
      reports.push(
        `⚠️ A branch principal está em \`${main.sha.slice(0, 7)}\` (${mergeTitle(main.message, main.sha)}) desde ${when(main.date)} e o Coolify não iniciou deploy dela. O webhook pode ter falhado.`
      )
      state.avisados.push(key)
    }
  }
  state.avisados = state.avisados.slice(-50)
  return { state, reports }
}

// ── Tarefas agendadas ──────────────────────────────────────────────────────────────────────────

// Apelidos de frequência que o Coolify aceita além do cron de 5 campos.
const ALIASES: Record<string, string> = {
  every_minute: '* * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
  monthly: '0 0 1 * *',
  yearly: '0 0 1 1 *',
  annually: '0 0 1 1 *'
}

export function cronOf(frequency: string): string | null {
  const value = frequency.trim().replace(/^@/, '')
  const expression = ALIASES[value] ?? frequency.trim()
  try {
    new Cron(expression, { paused: true, mode: '5-part' })
    return expression
  } catch {
    return null
  }
}

// Última hora prevista na agenda até "before" (inclusive), ou null.
export function lastScheduled(expression: string, timezone: string, before: Date): Date | null {
  const cron = new Cron(expression, { timezone, paused: true, mode: '5-part' })
  const first = cron.nextRun(new Date(before.getTime() - 40 * 24 * 60 * 60 * 1000))
  const second = first ? cron.nextRun(first) : null
  const period = first && second ? second.getTime() - first.getTime() : 24 * 60 * 60 * 1000
  let cursor: Date | null = cron.nextRun(new Date(before.getTime() - Math.max(2 * period, 60 * 60 * 1000) - 1000))
  let last: Date | null = null
  while (cursor && cursor.getTime() <= before.getTime()) {
    last = cursor
    cursor = cron.nextRun(cursor)
  }
  return last
}

function periodMs(expression: string, timezone: string, at: Date): number {
  const cron = new Cron(expression, { timezone, paused: true, mode: '5-part' })
  const a = cron.nextRun(at)
  const b = a ? cron.nextRun(a) : null
  return a && b ? b.getTime() - a.getTime() : 24 * 60 * 60 * 1000
}

// Problema de uma tarefa agendada (null = normal): desabilitada, última execução falhou, ou faltou
// a execução prevista. A folga é de 2 intervalos, entre 10 e 30 minutos (no Hermes: a cada 5 min
// avisava com 15 min sem rodar; a diária das 07h avisava depois das 07h30).
export function taskProblem(input: { task: CoolifyTask; executions: CoolifyExecution[]; now: Date; timezone: string; watchingSince: string }): string | null {
  const { task, now, timezone } = input
  if (!task.enabled) return 'desabilitada no Coolify'
  const executions = [...input.executions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latest = executions.find((execution) => execution.status !== 'running') ?? executions[0]
  if (latest?.status === 'failed') {
    return `última execução falhou em ${hora(latest.createdAt, timezone)}${latest.message ? `: ${latest.message.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`
  }
  const expression = cronOf(task.frequency)
  if (!expression) return `agenda "${task.frequency}" que o vigia não entende`
  const grace = Math.min(30 * 60 * 1000, Math.max(10 * 60 * 1000, 2 * periodMs(expression, timezone, now)))
  const expected = lastScheduled(expression, timezone, new Date(now.getTime() - grace))
  if (!expected) return null
  const from = Math.max(new Date(task.createdAt || 0).getTime() || 0, new Date(input.watchingSince).getTime())
  if (expected.getTime() < from) return null
  const newest = executions[0] ? new Date(executions[0].createdAt).getTime() : 0
  if (newest >= expected.getTime() - 60 * 1000) return null
  return executions[0]
    ? `sem execução desde ${hora(executions[0].createdAt, timezone)} (prevista às ${hora(expected, timezone)}, agenda \`${task.frequency}\`)`
    : `nenhuma execução registrada (prevista às ${hora(expected, timezone)}, agenda \`${task.frequency}\`)`
}

// ── Saúde ──────────────────────────────────────────────────────────────────────────────────────

export interface HealthCheckSpec {
  url: string
  // Campos esperados no JSON da resposta (ex.: { status: 'ok', banco: 'ok' }). Vazio = só HTTP 200.
  expect: Record<string, string>
}

export async function healthProblem(probe: HttpProbe, check: HealthCheckSpec): Promise<string | null> {
  let result: { status: number; body: string }
  try {
    result = await probe(check.url)
  } catch (error) {
    return `sem resposta (${(error as Error).message.slice(0, 150)})`
  }
  if (result.status !== 200) return `HTTP ${result.status}`
  const keys = Object.keys(check.expect)
  if (keys.length === 0) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(result.body) as Record<string, unknown>
  } catch {
    return 'resposta não é JSON válido'
  }
  const wrong = keys.filter((key) => String(data[key]) !== check.expect[key])
  if (wrong.length === 0) return null
  return `${keys.map((key) => `${key}=${JSON.stringify(data[key] ?? null)}`).join(' ')} (esperado ${keys.map((key) => check.expect[key]).join('/')})`
}

// ── Avisos só na mudança ───────────────────────────────────────────────────────────────────────

export interface WatchItem {
  key: string
  name: string
  problem: string | null
}

// Primeira volta: o panorama inteiro. Depois: só problema novo, problema que mudou e o que voltou
// ao normal — nunca o mesmo alerta duas vezes.
export function transitions(previous: Record<string, string | null> | null, items: WatchItem[]): { lines: string[]; first: boolean } {
  if (!previous) {
    return { lines: items.map((item) => `${item.problem ? '🔴' : '✅'} ${item.name}: ${item.problem ?? 'normal'}`), first: true }
  }
  const lines: string[] = []
  for (const item of items) {
    const before = previous[item.key] ?? null
    if (before === null && item.problem !== null) lines.push(`🔴 Novo problema em ${item.name}: ${item.problem}`)
    else if (before !== null && item.problem === null) lines.push(`✅ ${item.name} voltou ao normal (estava: ${before})`)
    else if (before !== null && item.problem !== null && before !== item.problem) {
      // "sem execução desde X" muda de texto sem mudar de situação: só avisa quando muda o tipo.
      if (before.split(' ').slice(0, 3).join(' ') !== item.problem.split(' ').slice(0, 3).join(' ')) {
        lines.push(`⚠️ ${item.name} continua com problema, mudou de "${before}" para "${item.problem}"`)
      }
    }
  }
  return { lines, first: false }
}
