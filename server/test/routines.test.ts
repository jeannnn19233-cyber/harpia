import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeSchedule, presetToCron } from '../../shared/schedule.ts'
import { checkToolUse } from '../src/automation/policy.ts'
import { markdownToTelegramHtml, splitMessage } from '../src/notify/format.ts'
import type { TelegramClient, TelegramUpdate } from '../src/notify/telegram.ts'
import { failureReason, isSilent } from '../src/routines/prompt.ts'
import { scheduleProblem } from '../src/routines/schedule.ts'
import { fakeProviders } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; html: boolean }[] = []
  readonly queue: TelegramUpdate[] = []
  async getMe() {
    return { username: 'harpia_bot' }
  }
  async getUpdates() {
    return this.queue.splice(0)
  }
  async sendMessage(chatId: string, text: string, options?: { html?: boolean }) {
    this.sent.push({ chatId, text, html: options?.html ?? false })
  }
}

let server: TestServer
let providers: ReturnType<typeof fakeProviders>
let telegram: FakeTelegram
let clock: Date
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (['GET', 'DELETE'].includes(method) ? undefined : {}) })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

async function linkTelegram() {
  const { link } = (await api('POST', '/api/me/notifications/telegram', ana.cookie)).json()
  telegram.queue.push({ update_id: 1, message: { chat: { id: 555 }, text: `/start ${link.code}` } })
  await server.ctx.notifier.pollOnce()
  telegram.sent.length = 0
}

async function newRoutine(body: object = {}) {
  const response = await api('POST', '/api/routines', ana.cookie, {
    name: 'Resumo da manhã',
    prompt: 'Resuma as notícias de tecnologia de hoje.',
    schedule: '0 9 * * *',
    ...body
  })
  expect(response.statusCode).toBe(200)
  return response.json().routine as { id: number; nextRunAt: string; enabled: boolean }
}

// Faz o "agente" responder e terminar a vez (o próximo que ainda não respondeu).
const answered = new Set<unknown>()
async function answer(text: string | null, error: string | null = null) {
  const pending = () => providers.created.find((item) => !answered.has(item) && item.sent.length > 0)
  await waitFor(() => pending() !== undefined)
  const provider = pending()!
  answered.add(provider)
  if (text !== null) provider.hooks.onTextDone('t1', text)
  provider.hooks.onTurnEnd(error)
  await server.services.routines.idle()
  return provider
}

async function runs(routineId: number) {
  return (await api('GET', `/api/routines/${routineId}/runs`, ana.cookie)).json().runs as {
    status: string
    error: string | null
    output: string | null
    delivered: boolean
    trigger: string
    chatId: number | null
  }[]
}

beforeEach(async () => {
  clock = new Date('2026-11-02T11:00:00Z') // 8h em São Paulo, segunda-feira
  providers = fakeProviders()
  telegram = new FakeTelegram()
  server = await startServer({
    agents: new FakeAgentSystem(),
    terminalsEnabled: true,
    chatProviders: providers.factory,
    telegram,
    now: () => clock,
    routineLimits: { inactivityMs: 2000 }
  })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
})

afterEach(async () => {
  await server.close()
})

describe('rotinas', () => {
  it('roda no horário, uma vez só, numa conversa nova com as ferramentas travadas, e entrega no Telegram', async () => {
    await linkTelegram()
    const routine = await newRoutine()
    expect(routine.nextRunAt).toBe('2026-11-02T12:00:00.000Z')

    await server.services.routines.tick()
    expect(providers.created).toHaveLength(0)

    clock = new Date('2026-11-02T12:00:20Z')
    await server.services.routines.tick()
    await server.services.routines.tick()
    const provider = await answer('**Destaques:** saiu a versão nova do Node.')
    expect(providers.created).toHaveLength(1)

    const input = provider.input
    expect(input.provider).toBe('claude')
    expect(input.cwd).toBe(`/fake/${ana.userId}/rotinas/${routine.id}`)
    expect(input.policy).toEqual({ tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch'], roots: [input.cwd] })
    expect(input.instructions).toContain('[SILENT]')
    expect(input.instructions).toContain('rotina agendada "Resumo da manhã"')
    expect(provider.sent[0]).toContain('## Tarefa\n\nResuma as notícias de tecnologia de hoje.')

    expect(telegram.sent).toEqual([
      { chatId: '555', text: '⏰ Resumo da manhã\n\n<b>Destaques:</b> saiu a versão nova do Node.', html: true }
    ])
    const [run] = await runs(routine.id)
    expect(run).toMatchObject({ status: 'ok', delivered: true, trigger: 'schedule' })
    const state = (await api('GET', '/api/routines', ana.cookie)).json().routines[0]
    expect(state).toMatchObject({ lastStatus: 'ok', nextRunAt: '2026-11-03T12:00:00.000Z', failureStreak: 0 })

    // A conversa da execução fica com a dona, fora da lista de conversas.
    expect((await api('GET', `/api/chats/${run.chatId}`, ana.cookie)).json().chat).toMatchObject({ origin: 'routine' })
    expect((await api('GET', `/api/chats/${run.chatId}`, bruno.cookie)).statusCode).toBe(404)
    expect((await api('GET', '/api/chats', ana.cookie)).json().chats).toEqual([])
  })

  it('[SILENT] não entrega nada; [FALHA] avisa uma vez por motivo e pausa depois de 5 falhas', async () => {
    await linkTelegram()
    const routine = await newRoutine()
    server.services.routines.runNow((await import('../src/routines/store.ts')).getRoutine(server.ctx.db, routine.id)!)
    await answer('[SILENT]')
    expect((await runs(routine.id))[0].status).toBe('silent')
    expect(telegram.sent).toEqual([])

    for (let i = 0; i < 5; i++) {
      await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
      await answer('[FALHA]\nO site estava fora do ar.')
    }
    const texts = telegram.sent.map((message) => message.text)
    expect(texts[0]).toContain('A rotina falhou: O site estava fora do ar.')
    expect(texts.filter((text) => text.includes('A rotina falhou'))).toHaveLength(1)
    expect(texts.at(-1)).toContain('Falhou 5 vezes seguidas e foi pausada')
    const state = (await api('GET', '/api/routines', ana.cookie)).json().routines[0]
    expect(state).toMatchObject({ enabled: false, failureStreak: 5, lastStatus: 'failed' })

    // Religar zera as falhas.
    const resumed = await api('PATCH', `/api/routines/${routine.id}`, ana.cookie, { enabled: true })
    expect(resumed.json().routine).toMatchObject({ enabled: true, failureStreak: 0 })
  })

  it('com continuidade, a execução anterior entra no contexto', async () => {
    const routine = await newRoutine({ continuity: true, deliver: 'harpia' })
    await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
    await answer('Notícia A e notícia B.')
    await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
    const provider = await answer('Notícia C.')
    expect(provider.sent[0]).toContain('## Sua execução anterior')
    expect(provider.sent[0]).toContain('Notícia A e notícia B.')
    expect((await runs(routine.id))[0]).toMatchObject({ status: 'ok', delivered: false })
  })

  it('cota esgotada segura a rotina por uma hora e avisa uma vez', async () => {
    await linkTelegram()
    const routine = await newRoutine()
    await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
    await answer(null, 'Claude AI usage limit reached|1762000000')
    const state = (await api('GET', '/api/routines', ana.cookie)).json().routines[0]
    expect(state.holdUntil).toBe('2026-11-02T12:00:00.000Z')
    expect(telegram.sent.at(-1)?.text).toContain('A cota da sua assinatura do Claude acabou')
    // Enquanto espera a cota, o horário das 9h (12h UTC) não roda.
    clock = new Date('2026-11-02T11:59:00Z')
    await server.ctx.db.prepare("UPDATE routines SET next_run_at = '2026-11-02T11:58:00.000Z'").run()
    await server.services.routines.tick()
    expect(providers.created).toHaveLength(1)
  })

  it('horário perdido por muito tempo vira execução pulada, sem gastar a cota', async () => {
    const routine = await newRoutine()
    clock = new Date('2026-11-02T18:00:00Z') // 6 horas depois das 9h
    await server.services.routines.tick()
    expect(providers.created).toHaveLength(0)
    const [run] = await runs(routine.id)
    expect(run).toMatchObject({ status: 'skipped', error: 'Horário perdido: o servidor estava fora do ar.' })
    expect((await api('GET', '/api/routines', ana.cookie)).json().routines[0].nextRunAt).toBe('2026-11-03T12:00:00.000Z')
  })

  it('para o agente que fica parado tempo demais', async () => {
    const routine = await newRoutine()
    await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
    await waitFor(() => providers.created.length === 1)
    await server.services.routines.idle()
    const [run] = await runs(routine.id)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('sem responder')
    expect(providers.last().closed).toBe(true)
  }, 10000)

  it('são pessoais e validam o horário', async () => {
    const routine = await newRoutine()
    expect((await api('GET', '/api/routines', bruno.cookie)).json().routines).toEqual([])
    expect((await api('POST', `/api/routines/${routine.id}/run`, bruno.cookie)).statusCode).toBe(404)
    expect((await api('DELETE', `/api/routines/${routine.id}`, bruno.cookie)).statusCode).toBe(404)

    const tooOften = await api('POST', '/api/routines', ana.cookie, { name: 'X', prompt: 'x', schedule: '*/5 * * * *' })
    expect(tooOften.json().error).toContain('15 minutos')
    const invalid = await api('POST', '/api/routines', ana.cookie, { name: 'Y', prompt: 'x', schedule: 'toda hora sim' })
    expect(invalid.statusCode).toBe(400)
    const duplicated = await api('POST', '/api/routines', ana.cookie, { name: 'resumo da manhã', prompt: 'x', schedule: '0 8 * * *' })
    expect(duplicated.statusCode).toBe(409)

    const preview = (await api('GET', `/api/routines/preview?schedule=${encodeURIComponent('0 9 * * 1-5')}`, ana.cookie)).json()
    expect(preview).toEqual({ problem: null, next: ['2026-11-02T12:00:00.000Z', '2026-11-03T12:00:00.000Z', '2026-11-04T12:00:00.000Z'] })

    expect((await api('DELETE', `/api/routines/${routine.id}`, ana.cookie)).statusCode).toBe(200)
    expect((await api('GET', '/api/routines', ana.cookie)).json().routines).toEqual([])
  })

  it('rotina no cofre trabalha na pasta do cofre e sem web quando pedido', async () => {
    const routine = await newRoutine({ folder: 'vault', web: false })
    await api('POST', `/api/routines/${routine.id}/run`, ana.cookie)
    const provider = await answer('[SILENT]')
    expect(provider.input.cwd).toBe(`/fake/${ana.userId}/cofre`)
    expect(provider.input.policy?.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit'])
  })
})

describe('peças das rotinas', () => {
  it('horários em português', () => {
    expect(describeSchedule(presetToCron({ kind: 'weekdays', hour: 9, minute: 0 }))).toBe('dias úteis às 09:00')
    expect(describeSchedule('30 7 * * *')).toBe('todo dia às 07:30')
    expect(describeSchedule('0 18 * * 5')).toBe('toda sexta às 18:00')
    expect(describeSchedule('0 */2 * * *')).toBe('a cada 2 horas')
    expect(describeSchedule('0 9 1 * *')).toBe('cron: 0 9 1 * *')
    expect(scheduleProblem('0 9 * * *', 'America/Sao_Paulo')).toBeNull()
  })

  it('reconhece silêncio e falha só nas formas combinadas', () => {
    expect(isSilent('[SILENT]')).toBe(true)
    expect(isSilent('nada novo\n[silent]')).toBe(true)
    expect(isSilent('Hoje [SILENT] talvez')).toBe(false)
    expect(failureReason('[FALHA]\nsem rede')).toBe('sem rede')
    expect(failureReason('Tudo certo, sem [FALHA]')).toBeNull()
  })

  it('converte markdown para o HTML do Telegram e divide mensagens longas', () => {
    expect(markdownToTelegramHtml('# Título\n- item **forte** e `a<b>`\n[site](https://x.com)')).toBe(
      '<b>Título</b>\n• item <b>forte</b> e <code>a&lt;b&gt;</code>\n<a href="https://x.com">site</a>'
    )
    expect(markdownToTelegramHtml('```\nif (a < b) {}\n```')).toBe('<pre>if (a &lt; b) {}</pre>')
    const parts = splitMessage(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`)
    expect(parts.map((part) => part.length)).toEqual([3000, 3000])
  })

  it('a trava das execuções automáticas não deixa sair da pasta, nem por link simbólico', async () => {
    const base = mkdtempSync(join(tmpdir(), 'harpia-policy-'))
    try {
      const vault = join(base, 'cofre')
      mkdirSync(vault)
      writeFileSync(join(base, 'segredo.txt'), 'token')
      symlinkSync(join(base, 'segredo.txt'), join(vault, 'atalho.md'))
      const policy = { tools: ['Read', 'Write', 'Glob', 'WebFetch'], roots: [vault] }
      expect(await checkToolUse(policy, 'Read', { file_path: 'nota.md' }, vault)).toBeNull()
      expect(await checkToolUse(policy, 'Write', { file_path: join(vault, 'nova/pasta/nota.md') }, vault)).toBeNull()
      expect(await checkToolUse(policy, 'Read', { file_path: '../segredo.txt' }, vault)).toContain('Fora das pastas')
      expect(await checkToolUse(policy, 'Read', { file_path: join(vault, 'atalho.md') }, vault)).toContain('Fora das pastas')
      expect(await checkToolUse(policy, 'Glob', { pattern: '*', path: '/etc' }, vault)).toContain('Fora das pastas')
      expect(await checkToolUse(policy, 'WebFetch', { url: 'https://x.com' }, vault)).toBeNull()
      expect(await checkToolUse(policy, 'Bash', { command: 'cat ~/.claude/.credentials.json' }, vault)).toContain('não está liberada')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
