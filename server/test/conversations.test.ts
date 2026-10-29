import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { ChatModel, RealtimeMessage } from '../../shared/types.ts'
import type { ModelLister } from '../src/chat/providers/types.ts'
import { fakeProviders } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let agents: FakeAgentSystem
let providers: ReturnType<typeof fakeProviders>
let listed: { provider: string; userId: number; cwd: string }[]
let listerResult: () => Promise<ChatModel[]>
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (['GET', 'DELETE'].includes(method) ? undefined : {}) })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

function connect(cookie: string): Promise<{ socket: WebSocket; messages: RealtimeMessage[] }> {
  const address = server.app.server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, { headers: { cookie } })
    const messages: RealtimeMessage[] = []
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    socket.on('open', () => resolve({ socket, messages }))
    socket.on('error', reject)
  })
}

async function newChat(cookie = ana.cookie, body: object = { provider: 'claude' }) {
  const response = await api('POST', '/api/chats', cookie, body)
  expect(response.statusCode).toBe(200)
  return response.json().chat as { id: number; taskId: number | null; shared: boolean; model: string | null; userId: number }
}

beforeEach(async () => {
  agents = new FakeAgentSystem()
  providers = fakeProviders()
  listed = []
  listerResult = async () => [{ id: 'opus', label: 'Opus', description: 'O mais capaz' }]
  const lister: ModelLister = async (input) => {
    listed.push({ provider: input.provider, userId: input.user.id, cwd: input.cwd })
    return listerResult()
  }
  server = await startServer({ agents, terminalsEnabled: true, chatProviders: providers.factory, chatModels: lister })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
})

afterEach(async () => {
  await server.close()
})

describe('conversas fora das tasks', () => {
  it('são privadas: a equipe não vê, não lista e não envia', async () => {
    const chat = await newChat()
    expect(chat).toMatchObject({ taskId: null, shared: false, model: null, userId: ana.userId })
    expect(agents.folders).toHaveLength(1)
    expect(agents.folders[0]).toMatch(/^\/fake\/1\/conversas\/\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/)

    expect((await api('GET', '/api/chats', ana.cookie)).json().chats.map((item: { id: number }) => item.id)).toEqual([chat.id])
    expect((await api('GET', '/api/chats', bruno.cookie)).json().chats).toEqual([])
    expect((await api('GET', `/api/chats/${chat.id}`, bruno.cookie)).statusCode).toBe(404)
    expect((await api('POST', `/api/chats/${chat.id}/messages`, bruno.cookie, { text: 'oi' })).statusCode).toBe(404)
    // Não entram no quadro de quem está trabalhando.
    expect((await api('GET', '/api/chats/active', bruno.cookie)).json().chats).toEqual([])
  })

  it('o agente recebe o contexto de conversa fora das tasks e o título vem da primeira mensagem', async () => {
    const chat = await newChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'Explique o que é um git rebase' })
    expect(providers.last().input.instructions).toContain('fora de qualquer task')
    expect(providers.last().input.cwd).toBe(agents.folders[0])
    const state = (await api('GET', `/api/chats/${chat.id}`, ana.cookie)).json()
    expect(state.chat).toMatchObject({ title: 'Explique o que é um git rebase', status: 'working' })
  })

  it('ao vivo, só a dona recebe; compartilhar mostra para a equipe e deixar de compartilhar esconde', async () => {
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    const anaConn = await connect(ana.cookie)
    const brunoConn = await connect(bruno.cookie)
    const chat = await newChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'segredo' })
    await waitFor(() => anaConn.messages.some((message) => message.type === 'chat_item'))
    const seenByBruno = () => brunoConn.messages.filter((message) => ['chat', 'chat_item'].includes(message.type))
    expect(seenByBruno()).toEqual([])

    const shared = await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { shared: true })
    expect(shared.json().chat.shared).toBe(true)
    await waitFor(() => seenByBruno().length > 0)
    expect((await api('GET', '/api/chats', bruno.cookie)).json().chats).toHaveLength(1)
    const view = await api('GET', `/api/chats/${chat.id}`, bruno.cookie)
    expect(view.json().items[0]).toMatchObject({ kind: 'user', text: 'segredo' })
    // Compartilhada é só leitura para a equipe.
    expect((await api('POST', `/api/chats/${chat.id}/messages`, bruno.cookie, { text: 'oi' })).statusCode).toBe(403)

    await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { shared: false })
    await waitFor(() => brunoConn.messages.some((message) => message.type === 'chat_removed'))
    expect(anaConn.messages.some((message) => message.type === 'chat_removed')).toBe(false)
    expect((await api('GET', `/api/chats/${chat.id}`, bruno.cookie)).statusCode).toBe(404)
    anaConn.socket.close()
    brunoConn.socket.close()
  })

  it('a dona renomeia e exclui; conversas de task não podem ser excluídas nem compartilhadas', async () => {
    const chat = await newChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'oi' })
    const renamed = await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { title: 'Dúvidas de git' })
    expect(renamed.json().chat.title).toBe('Dúvidas de git')
    expect((await api('DELETE', `/api/chats/${chat.id}`, bruno.cookie)).statusCode).toBe(404)
    expect((await api('DELETE', `/api/chats/${chat.id}`, ana.cookie)).statusCode).toBe(200)
    expect(providers.last().closed).toBe(true)
    expect((await api('GET', `/api/chats/${chat.id}`, ana.cookie)).statusCode).toBe(404)
    expect((await api('GET', '/api/chats', ana.cookie)).json().chats).toEqual([])

    const project = (await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: 'https://github.com/a/b.git' })).json().project
    for (let i = 0; i < 100; i++) {
      if ((await api('GET', `/api/projects/${project.id}`, ana.cookie)).json().project.cloneStatus === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const task = (await api('POST', `/api/projects/${project.id}/tasks`, ana.cookie, { title: 'Checkout' })).json().task
    const taskChat = (await api('POST', `/api/tasks/${task.id}/chats`, ana.cookie, { provider: 'codex' })).json().chat
    expect(taskChat.shared).toBe(false)
    expect((await api('DELETE', `/api/chats/${taskChat.id}`, ana.cookie)).statusCode).toBe(400)
    expect((await api('PATCH', `/api/chats/${taskChat.id}`, ana.cookie, { shared: true })).statusCode).toBe(400)
    // Mas a equipe vê a conversa da task, como antes.
    expect((await api('GET', `/api/chats/${taskChat.id}`, bruno.cookie)).statusCode).toBe(200)
    // E a conversa da task também aceita escolher o modelo.
    await api('PATCH', `/api/chats/${taskChat.id}`, ana.cookie, { model: 'opus' })
    expect((await api('GET', `/api/chats/${taskChat.id}`, ana.cookie)).json().chat.model).toBe('opus')
  })
})

describe('escolha do modelo', () => {
  it('começa com o modelo escolhido e troca no meio da conversa', async () => {
    const chat = await newChat(ana.cookie, { provider: 'claude', model: 'opus' })
    expect(chat.model).toBe('opus')
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'oi' })
    expect(providers.last().input.model).toBe('opus')

    const changed = await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { model: 'sonnet' })
    expect(changed.json().chat.model).toBe('sonnet')
    expect(providers.last().model).toBe('sonnet')

    await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { model: null })
    expect(providers.last().model).toBeNull()
    expect((await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { model: 'rm -rf /' })).statusCode).toBe(400)
    expect((await api('PATCH', `/api/chats/${chat.id}`, bruno.cookie, { model: 'opus' })).statusCode).toBe(404)
  })

  it('lista os modelos da conta de cada pessoa, guarda por um tempo e explica quando falha', async () => {
    const first = await api('GET', '/api/me/models?provider=claude', ana.cookie)
    expect(first.json()).toEqual({ models: [{ id: 'opus', label: 'Opus', description: 'O mais capaz' }], error: null })
    await api('GET', '/api/me/models?provider=claude', ana.cookie)
    expect(listed).toEqual([{ provider: 'claude', userId: ana.userId, cwd: '/fake/1' }])

    listerResult = async () => {
      throw new Error('sem login')
    }
    const failed = await api('GET', '/api/me/models?provider=codex', bruno.cookie)
    expect(failed.json().models).toEqual([])
    expect(failed.json().error).toContain('modelo padrão')
    expect((await api('GET', '/api/me/models?provider=gemini', ana.cookie)).statusCode).toBe(400)
  })
})
