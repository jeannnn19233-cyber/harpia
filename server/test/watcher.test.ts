import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangedFile, User } from '../../shared/types.ts'
import type { TelegramClient, TelegramUpdate } from '../src/notify/telegram.ts'
import { fakeProviders } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

// Alterações diferentes na cópia de cada pessoa.
class PerPersonAgents extends FakeAgentSystem {
  readonly byUser = new Map<number, string[]>()
  override async changedFiles(input: { user: User; path: string; base: string }): Promise<ChangedFile[]> {
    return (this.byUser.get(input.user.id) ?? []).map((path) => ({ path, status: 'M', additions: 1, deletions: 0 }))
  }
}

class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string }[] = []
  readonly queue: TelegramUpdate[] = []
  async getMe() {
    return { username: 'harpia_bot' }
  }
  async getUpdates() {
    return this.queue.splice(0)
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text })
  }
}

let server: TestServer
let agents: PerPersonAgents
let telegram: FakeTelegram
let providers: ReturnType<typeof fakeProviders>
let clock: Date
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let projectId: number

const later = (hours: number) => (clock = new Date(clock.getTime() + hours * 3600000))

async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (['GET', 'DELETE'].includes(method) ? undefined : {}) })
}

async function newTask(title: string, cookie = ana.cookie) {
  return (await api('POST', `/api/projects/${projectId}/tasks`, cookie, { title })).json().task as { id: number; number: number }
}

async function check() {
  return (await api('POST', `/api/projects/${projectId}/findings/check`, ana.cookie)).json().findings as {
    id: number
    kind: string
    message: string
    taskIds: number[]
    userIds: number[]
  }[]
}

beforeEach(async () => {
  clock = new Date('2026-10-01T12:00:00Z')
  agents = new PerPersonAgents()
  telegram = new FakeTelegram()
  providers = fakeProviders()
  server = await startServer({
    agents,
    telegram,
    chatProviders: providers.factory,
    terminalsEnabled: true,
    now: () => clock
  })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  projectId = (await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: 'https://github.com/a/b.git' })).json().project.id
  for (let i = 0; i < 100; i++) {
    if ((await api('GET', `/api/projects/${projectId}`, ana.cookie)).json().project.cloneStatus === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
})

afterEach(async () => {
  await server.close()
})

describe('vigia', () => {
  it('avisa task parada, registra na task, não repete e resolve quando volta a ter atividade', async () => {
    const task = await newTask('Checkout com Pix')
    await api('PATCH', `/api/tasks/${task.id}`, ana.cookie, { status: 'in_progress' })
    expect(await check()).toEqual([])

    later(50)
    const findings = await check()
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'stale', taskIds: [task.id], userIds: [ana.userId] })
    expect(findings[0].message).toBe('T-1 "Checkout com Pix" está parada há 2 dias, sem atividade de pessoas nem de agentes.')

    const events = (await api('GET', `/api/tasks/${task.id}`, ana.cookie)).json().events
    expect(events.at(-1)).toMatchObject({ type: 'watcher_notice', actorId: null, data: { kind: 'stale' } })

    expect(await check()).toHaveLength(1)
    const again = (await api('GET', `/api/tasks/${task.id}`, ana.cookie)).json().events
    expect(again.filter((event: { type: string }) => event.type === 'watcher_notice')).toHaveLength(1)

    await api('POST', `/api/tasks/${task.id}/comments`, ana.cookie, { body: 'Voltei.' })
    expect(await check()).toEqual([])
  })

  it('não chama de parada uma task com agente trabalhando', async () => {
    const task = await newTask('Checkout')
    const chat = (await api('POST', `/api/tasks/${task.id}/chats`, ana.cookie, { provider: 'claude' })).json().chat
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'trabalhe' })
    later(72)
    expect(await check()).toEqual([])
  })

  it('pergunta sobre task em Revisão sem PR aberto', async () => {
    const task = await newTask('Checkout')
    await api('PATCH', `/api/tasks/${task.id}`, ana.cookie, { status: 'review' })
    later(30)
    const findings = await check()
    expect(findings.map((finding) => finding.kind)).toEqual(['review_without_pr'])
    expect(findings[0].message).toContain('sem PR aberto')
  })

  it('aponta tasks parecidas e respeita quando alguém dispensa o aviso', async () => {
    const a = await newTask('Checkout com Pix')
    const b = await newTask('Tela de checkout via Pix', bruno.cookie)
    await newTask('Relatório de vendas')
    const findings = await check()
    expect(findings.map((finding) => [finding.kind, finding.taskIds])).toEqual([['duplicate', [a.id, b.id]]])

    const dismissed = await api('POST', `/api/findings/${findings[0].id}/dismiss`, bruno.cookie)
    expect(dismissed.json().finding).toMatchObject({ status: 'dismissed', dismissedBy: bruno.userId })
    expect(await check()).toEqual([])
  })

  it('avisa quando duas pessoas alteram os mesmos arquivos', async () => {
    const front = await newTask('Front do checkout')
    const back = await newTask('API de pagamentos')
    await api('POST', `/api/tasks/${front.id}/terminal`, ana.cookie)
    await api('POST', `/api/tasks/${back.id}/terminal`, bruno.cookie)
    agents.byUser.set(ana.userId, ['src/checkout.ts', 'src/ui.tsx'])
    agents.byUser.set(bruno.userId, ['src/checkout.ts', 'src/api.ts'])

    const findings = await check()
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'file_overlap', taskIds: [front.id, back.id] })
    expect(findings[0].message).toBe(
      'Ana (T-1) e Bruno (T-2) estão alterando os mesmos arquivos: src/checkout.ts. Combinem quem mexe em quê para evitar conflito.'
    )

    agents.byUser.set(bruno.userId, ['src/api.ts'])
    expect(await check()).toEqual([])
  })
})

describe('tasks parecidas', () => {
  it('compara títulos ignorando acentos e plural simples', async () => {
    const { titleSimilarity, significantWords } = await import('../src/search/similar.ts')
    expect(significantWords('Integração de pagamentos com Pix')).toEqual(['integracao', 'pagamento', 'pix'])
    expect(titleSimilarity('Integração de pagamentos com Pix', 'Pagamento via pix no checkout')).toBeGreaterThanOrEqual(0.6)
    expect(titleSimilarity('Relatório de vendas', 'Pagamento via pix')).toBe(0)
  })

  it('mostra tasks parecidas enquanto a pessoa digita, sem diferenciar acentos', async () => {
    await newTask('Integração de pagamentos com Pix')
    await newTask('Relatório de vendas')
    const response = await api('GET', `/api/projects/${projectId}/similar-tasks?q=${encodeURIComponent('pagamento pix')}`, ana.cookie)
    expect(response.json().tasks.map((task: { title: string }) => task.title)).toEqual(['Integração de pagamentos com Pix'])
    const accents = await api('GET', `/api/projects/${projectId}/similar-tasks?q=integracao`, ana.cookie)
    expect(accents.json().tasks).toHaveLength(1)
  })
})

describe('memória do projeto', () => {
  it('a equipe edita a memória e ela entra, com a task, em toda conversa nova', async () => {
    const saved = await api('PUT', `/api/projects/${projectId}/memory`, ana.cookie, {
      body: 'Use pnpm. Testes com vitest. Nunca altere migrações antigas.'
    })
    expect(saved.json().memory).toMatchObject({ body: 'Use pnpm. Testes com vitest. Nunca altere migrações antigas.', updatedBy: ana.userId })

    const task = (await api('POST', `/api/projects/${projectId}/tasks`, ana.cookie, { title: 'Checkout', description: 'Aceitar Pix.' })).json().task
    const chat = (await api('POST', `/api/tasks/${task.id}/chats`, ana.cookie, { provider: 'codex' })).json().chat
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'comece' })
    const instructions = providers.last().input.instructions ?? ''
    expect(instructions).toContain('T-1 "Checkout"')
    expect(instructions).toContain('Aceitar Pix.')
    expect(instructions).toContain('Use pnpm.')
    expect(instructions).toContain('Não faça push')
  })

  it('recusa memória acima do limite', async () => {
    const response = await api('PUT', `/api/projects/${projectId}/memory`, ana.cookie, { body: 'x'.repeat(3001) })
    expect(response.statusCode).toBe(400)
  })
})

describe('avisos no Telegram', () => {
  async function linkTelegram(person: { cookie: string; userId: number }, chatId: number) {
    const { link } = (await api('POST', '/api/me/notifications/telegram', person.cookie)).json()
    expect(link.url).toBe(`https://t.me/harpia_bot?start=${link.code}`)
    telegram.queue.push({ update_id: chatId, message: { chat: { id: chatId }, text: `/start ${link.code}` } })
    await server.ctx.notifier.pollOnce()
  }

  it('vincula a conta pelo código e manda os avisos do vigia', async () => {
    await linkTelegram(ana, 555)
    expect(telegram.sent.at(-1)).toEqual({ chatId: '555', text: 'Pronto, Ana! A partir de agora você recebe aqui os avisos do Harpia.' })
    const settings = (await api('GET', '/api/me/notifications', ana.cookie)).json().settings
    expect(settings.telegram).toEqual({ available: true, botUsername: 'harpia_bot', linked: true })

    const task = await newTask('Checkout')
    await api('PATCH', `/api/tasks/${task.id}`, ana.cookie, { status: 'in_progress' })
    later(50)
    await check()
    expect(telegram.sent.at(-1)?.text).toContain('Vigia do Harpia\nT-1 "Checkout" está parada há 2 dias')
  })

  it('código errado ou usado não vincula nada', async () => {
    telegram.queue.push({ update_id: 1, message: { chat: { id: 9 }, text: '/start ERRADO12' } })
    await server.ctx.notifier.pollOnce()
    expect(telegram.sent.at(-1)?.text).toContain('gere um código')
    expect((await api('GET', '/api/me/notifications', ana.cookie)).json().settings.telegram.linked).toBe(false)
  })

  it('avisa quando o agente pede aprovação e a pessoa não está com o Harpia aberto', async () => {
    await linkTelegram(ana, 555)
    const task = await newTask('Checkout')
    const chat = (await api('POST', `/api/tasks/${task.id}/chats`, ana.cookie, { provider: 'claude' })).json().chat
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'rode os testes' })
    void providers.last().hooks.requestApproval({ title: 'Usar Bash', detail: 'npm test' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(telegram.sent.at(-1)?.text).toBe('Seu Claude está esperando aprovação em T-1 "Checkout":\nUsar Bash: npm test')
  })

  it('desvincular para os avisos', async () => {
    await linkTelegram(ana, 555)
    await api('DELETE', '/api/me/notifications/telegram', ana.cookie)
    expect((await api('GET', '/api/me/notifications', ana.cookie)).json().settings.telegram.linked).toBe(false)
  })
})
