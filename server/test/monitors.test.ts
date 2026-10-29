import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cronOf, deployRound, errorLines, healthProblem, lastScheduled, mergeTitle, taskProblem, transitions } from '../src/monitors/checks.ts'
import type { CoolifyApplication, CoolifyClient, CoolifyDeployment, CoolifyExecution, CoolifyTask } from '../src/monitors/coolify.ts'
import { toDeployment } from '../src/monitors/coolify.ts'
import { FakeGitHub } from './fake-github.ts'
import { FakeTelegram } from './fake-telegram.ts'
import { setupAdmin, startServer, type TestServer } from './helpers.ts'

const at = (iso: string) => new Date(iso)
const task = (extra: Partial<CoolifyTask> = {}): CoolifyTask => ({
  uuid: 't1',
  name: 'expirar-propostas',
  enabled: true,
  frequency: '*/5 * * * *',
  createdAt: '2026-10-01T00:00:00Z',
  ...extra
})
const run = (createdAt: string, status = 'success', message: string | null = null): CoolifyExecution => ({
  status,
  message,
  startedAt: createdAt,
  finishedAt: createdAt,
  createdAt
})
const dep = (id: number, status: string, extra: Partial<CoolifyDeployment> = {}): CoolifyDeployment => ({
  id,
  uuid: `d${id}`,
  status,
  commit: `${id}`.padStart(7, 'a') + 'ffffffff',
  commitMessage: `Merge pull request #${100 + id} from clarumi/x`,
  pullRequestId: 0,
  createdAt: '2026-10-29T12:00:00Z',
  updatedAt: '2026-10-29T12:05:00Z',
  logs: [],
  ...extra
})

describe('tarefas agendadas (vigia-crons)', () => {
  const since = '2026-10-01T00:00:00Z'

  it('a cada 5 minutos: avisa com uns 15 minutos sem rodar, como no Hermes', () => {
    const executions = [run('2026-10-29T12:00:00Z')]
    const check = (now: string) => taskProblem({ task: task(), executions, now: at(now), timezone: 'UTC', watchingSince: since })
    expect(check('2026-10-29T12:14:00Z')).toBeNull()
    expect(check('2026-10-29T12:16:00Z')).toMatch(/^sem execução desde 29\/10 12:00 \(prevista às 29\/10 12:05/)
  })

  it('diária às 07h: avisa depois das 07h30 se não rodou hoje, e não cobra antes de começar', () => {
    const daily = task({ frequency: '0 7 * * *', createdAt: '2026-10-17T15:00:00Z' })
    const yesterday = [run('2026-10-28T07:00:05Z')]
    const check = (now: string, executions = yesterday, watching = since) => taskProblem({ task: daily, executions, now: at(now), timezone: 'UTC', watchingSince: watching })
    expect(check('2026-10-29T07:20:00Z')).toBeNull()
    expect(check('2026-10-29T07:31:00Z')).toMatch(/^sem execução desde 28\/10 07:00/)
    expect(check('2026-10-29T07:31:00Z', [...yesterday, run('2026-10-29T07:00:03Z')])).toBeNull()
    // Antes da primeira execução automática prevista (tarefa criada depois das 07h): sem cobrança.
    expect(check('2026-10-17T20:00:00Z', [])).toBeNull()
    expect(check('2026-10-18T07:31:00Z', [])).toMatch(/^nenhuma execução registrada/)
  })

  it('falha, desabilitada e apelidos de agenda do Coolify', () => {
    const now = at('2026-10-29T12:03:00Z')
    expect(taskProblem({ task: task({ enabled: false }), executions: [], now, timezone: 'UTC', watchingSince: since })).toBe('desabilitada no Coolify')
    expect(
      taskProblem({ task: task(), executions: [run('2026-10-29T12:00:00Z', 'failed', 'exit code 1\n  relation "x" does not exist')], now, timezone: 'UTC', watchingSince: since })
    ).toBe('última execução falhou em 29/10 12:00: exit code 1 relation "x" does not exist')
    // Uma execução em andamento não esconde a falha anterior.
    expect(
      taskProblem({ task: task(), executions: [run('2026-10-29T12:00:00Z', 'failed'), run('2026-10-29T12:05:00Z', 'running')], now, timezone: 'UTC', watchingSince: since })
    ).toMatch(/falhou/)
    expect(cronOf('daily')).toBe('0 0 * * *')
    expect(cronOf('@hourly')).toBe('0 * * * *')
    expect(cronOf('isso não')).toBeNull()
    expect(lastScheduled('0 7 * * *', 'America/Sao_Paulo', at('2026-10-29T11:00:00Z'))?.toISOString()).toBe('2026-10-29T10:00:00.000Z')
  })
})

describe('saúde e avisos só na mudança', () => {
  it('confere HTTP 200 e os campos do JSON', async () => {
    const probe = async (url: string) =>
      url.endsWith('/ready') ? { status: 200, body: '{"status":"ok","banco":"falhou"}' } : url.endsWith('/down') ? { status: 503, body: '' } : { status: 200, body: 'oi' }
    expect(await healthProblem(probe, { url: 'https://x/ready', expect: { status: 'ok', banco: 'ok' } })).toBe('status="ok" banco="falhou" (esperado ok/ok)')
    expect(await healthProblem(probe, { url: 'https://x/down', expect: {} })).toBe('HTTP 503')
    expect(await healthProblem(probe, { url: 'https://x/', expect: {} })).toBeNull()
    expect(await healthProblem(probe, { url: 'https://x/', expect: { status: 'ok' } })).toBe('resposta não é JSON válido')
    expect(await healthProblem(async () => Promise.reject(new Error('ECONNREFUSED')), { url: 'https://x', expect: {} })).toBe('sem resposta (ECONNREFUSED)')
  })

  it('primeira volta manda o panorama; depois só problema novo, mudança e volta ao normal', () => {
    const items = [
      { key: 'a', name: 'A', problem: null },
      { key: 'b', name: 'B', problem: 'HTTP 503' }
    ]
    expect(transitions(null, items)).toEqual({ lines: ['✅ A: normal', '🔴 B: HTTP 503'], first: true })
    expect(transitions({ a: null, b: 'HTTP 503' }, items).lines).toEqual([])
    expect(
      transitions({ a: null, b: 'HTTP 503' }, [
        { key: 'a', name: 'A', problem: 'desabilitada no Coolify' },
        { key: 'b', name: 'B', problem: null }
      ]).lines
    ).toEqual(['🔴 Novo problema em A: desabilitada no Coolify', '✅ B voltou ao normal (estava: HTTP 503)'])
    // "sem execução desde ..." que só muda o horário não repete o alerta.
    expect(transitions({ a: 'sem execução desde 12:00 (prevista 12:05)' }, [{ key: 'a', name: 'A', problem: 'sem execução desde 12:00 (prevista 12:10)' }]).lines).toEqual([])
  })
})

describe('deploy (vigia-deploy)', () => {
  const base = {
    now: at('2026-10-29T12:10:00Z'),
    timezone: 'UTC',
    siteLabel: 'tudo no ar.',
    checkLive: async () => [] as string[],
    failedTasksSince: async () => [] as { name: string; status: string; message: string | null }[],
    mainHead: async () => null
  }

  it('primeira volta só marca o ponto de partida', async () => {
    const result = await deployRound({ ...base, deployments: [dep(5, 'finished'), dep(4, 'failed')], state: null })
    expect(result).toEqual({ state: { ultimo: 5, avisados: [] }, reports: [] })
  })

  it('relata deploy que falhou com as linhas de erro (sem segredo) e o que terminou bem', async () => {
    const logs = ['Building', 'npm ERR! missing script: build', 'TOKEN=abc failed', `error: push ghp_${'x'.repeat(30)}`, 'exit code 1']
    const result = await deployRound({
      ...base,
      deployments: [dep(7, 'finished'), dep(6, 'failed', { logs })],
      state: { ultimo: 5, avisados: [] },
      failedTasksSince: async () => [{ name: 'expirar-propostas', status: 'failed', message: 'exit code 2' }]
    })
    expect(result.state.ultimo).toBe(7)
    expect(result.reports[0]).toBe('❌ Deploy #6 (PR #106, `aaaaaa6`) **falhou** — 29/10 12:00 → 29/10 12:05.\n  · npm ERR! missing script: build\n  · exit code 1')
    expect(result.reports[1]).toBe('✅ Deploy #7 (PR #107, `aaaaaa7`) concluído — 29/10 12:00 → 29/10 12:05. tudo no ar.')
    expect(result.reports[2]).toBe('⚠️ Tarefa agendada `expirar-propostas` depois do deploy: failed — exit code 2')
    expect(errorLines(null)).toBeNull()
  })

  it('espera outro deploy em andamento antes de conferir o que está no ar', async () => {
    let checked = 0
    const input = { ...base, checkLive: async () => (checked++, ['/api/health respondeu 502']) }
    const busy = await deployRound({ ...input, deployments: [dep(9, 'in_progress'), dep(8, 'finished')], state: { ultimo: 7, avisados: [] } })
    expect(busy).toEqual({ state: { ultimo: 7, avisados: [] }, reports: [] })
    expect(checked).toBe(0)
    const done = await deployRound({ ...input, deployments: [dep(9, 'cancelled-by-user'), dep(8, 'finished')], state: busy.state })
    expect(done.reports.at(-1)).toBe('⚠️ Deploy #8 (PR #108, `aaaaaa8`) terminou às 29/10 12:05, mas:\n  · /api/health respondeu 502')
  })

  it('avisa uma vez de deploy preso e de merge na branch principal sem deploy', async () => {
    const input = {
      ...base,
      now: at('2026-10-29T12:30:00Z'),
      deployments: [dep(9, 'in_progress', { createdAt: '2026-10-29T12:05:00Z' })],
      mainHead: async () => ({ sha: 'bbbbbbb1234', message: 'Merge pull request #77 from x', date: '2026-10-29T12:15:00Z' })
    }
    const first = await deployRound({ ...input, state: { ultimo: 8, avisados: [] } })
    expect(first.reports).toEqual([
      '⏳ Deploy #9 (`aaaaaa9`) em andamento desde 29/10 12:05, há mais de 20 min.',
      '⚠️ A branch principal está em `bbbbbbb` (PR #77) desde 29/10 12:15 e o Coolify não iniciou deploy dela. O webhook pode ter falhado.'
    ])
    expect((await deployRound({ ...input, state: first.state })).reports).toEqual([])
    expect(mergeTitle('Corrige o login', 'abc1234567')).toBe('Corrige o login')
  })

  it('lê a resposta da API do Coolify (log em JSON, sem as linhas ocultas)', () => {
    const parsed = toDeployment({
      id: 3,
      deployment_uuid: 'u3',
      status: 'failed',
      commit: 'abc',
      pull_request_id: 0,
      created_at: '2026-10-29T12:00:00.000000Z',
      updated_at: '2026-10-29T12:01:00.000000Z',
      logs: JSON.stringify([{ output: 'docker build', hidden: true }, { output: 'error: x', hidden: false }])
    })
    expect(parsed).toMatchObject({ id: 3, uuid: 'u3', status: 'failed', commitMessage: null, logs: ['error: x'] })
  })
})

// Coolify de mentira para o fluxo completo pelo servidor.
class FakeCoolify implements CoolifyClient {
  app: CoolifyApplication = { uuid: 'app1', name: 'loja', status: 'running:healthy', gitBranch: 'main' }
  deployments: CoolifyDeployment[] = []
  tasks: CoolifyTask[] = []
  executions = new Map<string, CoolifyExecution[]>()
  down = false
  private guard() {
    if (this.down) throw new Error('Coolify respondeu 502')
  }
  async listApplications() {
    this.guard()
    return [{ uuid: 'app1', name: 'loja' }]
  }
  async getApplication() {
    this.guard()
    return this.app
  }
  async listDeployments() {
    this.guard()
    return this.deployments
  }
  async listScheduledTasks() {
    this.guard()
    return this.tasks
  }
  async listExecutions(_app: string, taskUuid: string) {
    return this.executions.get(taskUuid) ?? []
  }
}

describe('vigias pelo servidor', () => {
  let server: TestServer
  let coolify: FakeCoolify
  let telegram: FakeTelegram
  let clock: Date
  let health = { status: 200, body: '{"status":"ok","banco":"ok"}' }
  let cookie: string
  let projectId: number

  beforeEach(async () => {
    clock = at('2026-10-29T12:00:00Z')
    coolify = new FakeCoolify()
    telegram = new FakeTelegram()
    health = { status: 200, body: '{"status":"ok","banco":"ok"}' }
    const github = new FakeGitHub()
    github.commits.set('main', { sha: 'aaaaaa1ffffffff', message: 'Merge pull request #101', date: '2026-10-29T11:00:00Z' })
    server = await startServer({ coolify, telegram, github, now: () => clock, probe: async () => health })
    ;({ cookie } = await setupAdmin(server.app))
    projectId = (await server.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { name: 'Loja', repoUrl: 'https://github.com/clarumi/loja.git' } })).json()
      .project.id
    const { link } = (await server.app.inject({ method: 'POST', url: '/api/me/notifications/telegram', headers: { cookie }, payload: {} })).json()
    telegram.queue.push({ update_id: 1, message: { chat: { id: 555 }, text: `/start ${link.code}` } })
    await server.ctx.notifier.pollOnce()
    telegram.sent.length = 0
  })

  afterEach(async () => {
    await server.close()
  })

  const check = async () => (await server.app.inject({ method: 'POST', url: `/api/projects/${projectId}/monitor/check`, headers: { cookie }, payload: {} })).json()
  const configure = (payload: object) => server.app.inject({ method: 'PUT', url: `/api/projects/${projectId}/monitor`, headers: { cookie }, payload })
  const config = {
    enabled: true,
    coolifyAppUuid: 'app1',
    healthChecks: [{ url: 'https://www.loja.com/api/health/ready', expect: { status: 'ok', banco: 'ok' } }],
    timezone: 'UTC',
    notifyUserIds: []
  }

  it('panorama na primeira volta, silêncio quando nada muda, aviso quando muda e quando volta', async () => {
    coolify.tasks = [task({ createdAt: '2026-10-01T00:00:00Z' })]
    coolify.executions.set('t1', [run('2026-10-29T11:55:00Z')])
    coolify.deployments = [dep(1, 'finished')]
    expect((await server.app.inject({ method: 'GET', url: '/api/monitor/applications', headers: { cookie } })).json().applications).toEqual([{ uuid: 'app1', name: 'loja' }])
    expect((await configure({ ...config, coolifyAppUuid: '' })).statusCode).toBe(400)
    expect((await configure(config)).statusCode).toBe(200)

    let result = await check()
    expect(result.monitor.panorama.map((item: { problem: string | null }) => item.problem)).toEqual([null, null, null, null])
    expect(telegram.sent.map((item) => item.text)).toEqual([
      expect.stringContaining('Vigias de Loja — primeira verificação')
    ])
    expect(telegram.sent[0].text).toContain('Tarefa agendada "expirar-propostas": normal')

    telegram.sent.length = 0
    clock = at('2026-10-29T12:04:00Z')
    await check()
    expect(telegram.sent).toEqual([])

    // A tarefa para de rodar e a saúde cai.
    clock = at('2026-10-29T12:20:00Z')
    health = { status: 200, body: '{"status":"ok","banco":"falhou"}' }
    result = await check()
    const alert = telegram.sent.map((item) => item.text).join('\n')
    expect(alert).toContain('Novo problema em Tarefa agendada "expirar-propostas": sem execução desde 29/10 11:55')
    expect(alert).toContain('Novo problema em www.loja.com/api/health/ready')
    expect(result.events[0].text).toContain('Novo problema')

    // Novo deploy da main: relata e confere o que está no ar.
    telegram.sent.length = 0
    clock = at('2026-10-29T12:25:00Z')
    coolify.executions.set('t1', [run('2026-10-29T12:25:00Z')])
    health = { status: 200, body: '{"status":"ok","banco":"ok"}' }
    coolify.deployments = [dep(2, 'finished', { createdAt: '2026-10-29T12:21:00Z', updatedAt: '2026-10-29T12:24:00Z' }), dep(1, 'finished')]
    await check()
    const text = telegram.sent.map((item) => item.text).join('\n')
    expect(text).toContain('✅ Deploy #2 (PR #102')
    expect(text).toContain('voltou ao normal')

    // Coolify fora do ar: avisa uma vez e avisa quando volta.
    telegram.sent.length = 0
    coolify.down = true
    await check()
    await check()
    coolify.down = false
    await check()
    expect(telegram.sent.map((item) => item.text.split('\n\n')[1])).toEqual([
      '🔴 Novo problema em API do Coolify: não consegui verificar: Coolify respondeu 502',
      '✅ API do Coolify voltou ao normal (estava: não consegui verificar: Coolify respondeu 502)'
    ])
  })

  it('sem o token do Coolify no servidor, diz o que falta', async () => {
    await server.close()
    server = await startServer({ coolify: null, now: () => clock })
    ;({ cookie } = await setupAdmin(server.app))
    projectId = (await server.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { name: 'Loja', repoUrl: 'https://github.com/clarumi/loja.git' } })).json()
      .project.id
    const body = (await server.app.inject({ method: 'GET', url: `/api/projects/${projectId}/monitor`, headers: { cookie } })).json()
    expect(body.coolifyConfigured).toBe(false)
    const apps = await server.app.inject({ method: 'GET', url: '/api/monitor/applications', headers: { cookie } })
    expect(apps.statusCode).toBe(400)
    expect(apps.json().error).toContain('HARPIA_COOLIFY_TOKEN')
  })
})
