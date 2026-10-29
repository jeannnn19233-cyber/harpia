import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeProviders } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let providers: ReturnType<typeof fakeProviders>
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let taskId: number

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (method === 'GET' ? undefined : {}) })
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

async function chatState(chatId: number) {
  return (await api('GET', `/api/chats/${chatId}`, ana.cookie)).json() as {
    chat: { status: string; title: string; permissionMode: string; suggestion: string | null }
    items: Record<string, unknown>[]
  }
}

async function boot(dataDir?: string) {
  providers = fakeProviders()
  server = await startServer({ agents: new FakeAgentSystem(), terminalsEnabled: true, chatProviders: providers.factory, dataDir })
}

beforeEach(async () => {
  await boot()
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  const project = await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: 'https://github.com/a/b.git' })
  const projectId = project.json().project.id
  await waitFor(async () => (await api('GET', `/api/projects/${projectId}`, ana.cookie)).json().project.cloneStatus === 'ready')
  taskId = (await api('POST', `/api/projects/${projectId}/tasks`, ana.cookie, { title: 'Checkout' })).json().task.id
})

afterEach(async () => {
  await server.close()
})

async function openChat(cookie = ana.cookie, provider = 'claude') {
  const response = await api('POST', `/api/tasks/${taskId}/chats`, cookie, { provider })
  expect(response.statusCode).toBe(200)
  return response.json().chat as { id: number; status: string; provider: string; branch: string }
}

describe('conversas com agentes', () => {
  it('abrir uma conversa coloca a pessoa na task e tira a task do Backlog', async () => {
    const chat = await openChat(bruno.cookie, 'codex')
    expect(chat).toMatchObject({ provider: 'codex', status: 'idle', userId: bruno.userId })
    expect(chat).not.toHaveProperty('cwd')

    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task).toMatchObject({ status: 'in_progress', ownerId: bruno.userId })
    expect(detail.events.at(-1)).toMatchObject({ type: 'chat_started', data: { provider: 'codex' } })
    // O agente só é iniciado na primeira mensagem.
    expect(providers.created).toHaveLength(0)
  })

  it('envia a mensagem, mostra a resposta chegando aos pedaços e volta a esperar', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'Crie a tela de checkout com Pix' })
    const provider = providers.last()
    expect(provider.sent).toEqual(['Crie a tela de checkout com Pix'])
    expect(provider.input.cwd).toBe(`/fake/${ana.userId}/loja/T-1`)

    let state = await chatState(chat.id)
    expect(state.chat).toMatchObject({ status: 'working', title: 'Crie a tela de checkout com Pix' })

    provider.hooks.onSession('sessao-claude-1')
    provider.hooks.onTextDelta('m1:0', 'Vou ')
    provider.hooks.onTextDelta('m1:0', 'começar.')
    state = await chatState(chat.id)
    expect(state.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'Vou começar.', streaming: true })

    provider.hooks.onNotice('Tentando de novo (1 de 5)…')
    provider.hooks.onNotice('Tentando de novo (2 de 5)…')
    provider.hooks.onToolStart('t1', 'Bash', 'npm test')
    provider.hooks.onToolEnd('t1', true, '3 testes passaram')
    provider.hooks.onTextDone('m1:0', 'Vou começar.')
    provider.hooks.onTurnEnd(null)

    state = await chatState(chat.id)
    expect(state.chat.status).toBe('idle')
    // O aviso de andamento é um só, atualizado no lugar.
    expect(state.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'notice', 'tool'])
    expect(state.items[2]).toMatchObject({ text: 'Tentando de novo (2 de 5)…' })
    expect(state.items[1]).toMatchObject({ text: 'Vou começar.', streaming: false })
    expect(state.items[3]).toMatchObject({ name: 'Bash', summary: 'npm test', status: 'done', output: '3 testes passaram' })
  })

  it('só quem abriu conversa com o agente; a equipe só acompanha', async () => {
    const chat = await openChat()
    const denied = await api('POST', `/api/chats/${chat.id}/messages`, bruno.cookie, { text: 'oi' })
    expect(denied.statusCode).toBe(403)
    const view = await api('GET', `/api/chats/${chat.id}`, bruno.cookie)
    expect(view.statusCode).toBe(200)
  })

  it('mensagem enviada enquanto o agente trabalha entra no meio da vez dele', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'rode os testes' })
    const second = await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, {
      text: 'Enquanto os testes rodam, siga para a parte 4'
    })
    expect(second.statusCode).toBe(200)
    expect(providers.created).toHaveLength(1)
    expect(providers.last().sent).toEqual(['rode os testes'])
    expect(providers.last().steered).toEqual(['Enquanto os testes rodam, siga para a parte 4'])

    const state = await chatState(chat.id)
    expect(state.chat.status).toBe('working')
    expect(state.items.at(-1)).toMatchObject({ kind: 'user', steer: true })

    await api('POST', `/api/chats/${chat.id}/interrupt`, ana.cookie)
    expect(providers.last().interrupted).toBe(1)
  })

  it('com aprovação pendente, pede a resposta antes de outra mensagem', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'x' })
    void providers.last().hooks.requestApproval({ title: 'Usar Bash', detail: 'ls' })
    const response = await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'y' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('aprovação')
  })

  it('guarda a sugestão de próxima mensagem e limpa quando a pessoa envia', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'primeira' })
    providers.last().hooks.onTurnEnd(null)
    providers.last().hooks.onSuggestion('Agora rode os testes de integração')
    expect((await chatState(chat.id)).chat).toMatchObject({ status: 'idle', suggestion: 'Agora rode os testes de integração' })
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'Agora rode os testes de integração' })
    expect((await chatState(chat.id)).chat.suggestion).toBeNull()
  })

  it('volta a "trabalhando" se o agente continuar depois do fim da vez', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'primeira' })
    providers.last().hooks.onTurnEnd(null)
    providers.last().hooks.onTextDelta('m9', 'continuando a parte 4…')
    expect((await chatState(chat.id)).chat.status).toBe('working')
  })

  it('pede aprovação e espera a decisão da dona da conversa', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'rode os testes' })
    const decision = providers.last().hooks.requestApproval({ title: 'Usar Bash', detail: 'npm test' })

    let state = await chatState(chat.id)
    expect(state.chat.status).toBe('waiting')
    const approval = state.items.at(-1) as { id: number; kind: string; status: string }
    expect(approval).toMatchObject({ kind: 'approval', status: 'pending', title: 'Usar Bash' })

    const byBruno = await api('POST', `/api/chats/${chat.id}/approvals/${approval.id}`, bruno.cookie, { decision: 'allow' })
    expect(byBruno.statusCode).toBe(403)

    const allowed = await api('POST', `/api/chats/${chat.id}/approvals/${approval.id}`, ana.cookie, { decision: 'allow' })
    expect(allowed.json().item).toMatchObject({ status: 'allowed', decidedBy: ana.userId })
    expect(await decision).toBe('allow')
    state = await chatState(chat.id)
    expect(state.chat.status).toBe('working')

    const again = await api('POST', `/api/chats/${chat.id}/approvals/${approval.id}`, ana.cookie, { decision: 'deny' })
    expect(again.statusCode).toBe(409)
  })

  it('aprovações pendentes expiram quando a vez do agente termina', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'x' })
    const decision = providers.last().hooks.requestApproval({ title: 'Usar Bash', detail: 'rm -rf build' })
    providers.last().hooks.onTurnEnd('Interrompido')
    expect(await decision).toBe('deny')
    const state = await chatState(chat.id)
    expect(state.items.map((item) => [item.kind, item.status ?? item.text])).toEqual([
      ['user', 'x'],
      ['approval', 'expired'],
      ['error', 'Interrompido']
    ])
  })

  it('se o agente cai, avisa e retoma a mesma conversa na próxima mensagem', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'primeira' })
    const first = providers.last()
    first.hooks.onSession('sessao-123')
    first.hooks.onExit('Processo encerrado')

    let state = await chatState(chat.id)
    expect(state.chat.status).toBe('idle')
    expect(state.items.at(-1)).toMatchObject({ kind: 'error', text: 'Processo encerrado' })

    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'segunda' })
    expect(providers.created).toHaveLength(2)
    expect(providers.last().input.resumeId).toBe('sessao-123')
    // Eventos atrasados do processo antigo são ignorados.
    first.hooks.onTextDone('velho', 'não deve aparecer')
    state = await chatState(chat.id)
    expect(state.items.some((item) => item.text === 'não deve aparecer')).toBe(false)
  })

  it('muda o modo de permissão e encerra a conversa', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'oi' })
    const updated = await api('PATCH', `/api/chats/${chat.id}`, ana.cookie, { permissionMode: 'edits' })
    expect(updated.json().chat.permissionMode).toBe('edits')
    expect(providers.last().mode).toBe('edits')

    const closed = await api('POST', `/api/chats/${chat.id}/close`, ana.cookie)
    expect(closed.json().chat.status).toBe('closed')
    expect(providers.last().closed).toBe(true)
    const late = await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'de novo' })
    expect(late.statusCode).toBe(409)
  })

  it('lista as conversas abertas para o quadro', async () => {
    const first = await openChat()
    const second = await openChat(bruno.cookie, 'codex')
    await api('POST', `/api/chats/${first.id}/close`, ana.cookie)
    const active = (await api('GET', '/api/chats/active', ana.cookie)).json().chats
    expect(active.map((chat: { id: number }) => chat.id)).toEqual([second.id])
    const all = (await api('GET', `/api/tasks/${taskId}/chats`, ana.cookie)).json().chats
    expect(all).toHaveLength(2)
  })

  it('depois de reiniciar o servidor, conversas que estavam trabalhando avisam que foram interrompidas', async () => {
    const chat = await openChat()
    await api('POST', `/api/chats/${chat.id}/messages`, ana.cookie, { text: 'trabalhe' })
    const dataDir = server.dataDir
    await server.close(true)
    await boot(dataDir)
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'ana@exemplo.com', password: 'senha-forte-1' }
    })
    ana.cookie = `harpia_session=${login.cookies.find((cookie) => cookie.name === 'harpia_session')?.value}`
    const state = await chatState(chat.id)
    expect(state.chat.status).toBe('idle')
    expect(state.items.at(-1)).toMatchObject({ kind: 'error' })
  })
})

describe('terminal de baixo', () => {
  it('abrir o terminal de apoio não coloca a pessoa na task nem muda o histórico', async () => {
    const before = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    await api('POST', `/api/tasks/${taskId}/terminal`, bruno.cookie)
    const after = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(after.task.participantIds).toEqual(before.task.participantIds)
    expect(after.task.status).toBe('backlog')
    expect(after.events).toHaveLength(before.events.length)
  })

  it('reaproveita o terminal da pessoa na task', async () => {
    const first = (await api('POST', `/api/tasks/${taskId}/terminal`, ana.cookie)).json().session
    const again = (await api('POST', `/api/tasks/${taskId}/terminal`, ana.cookie)).json().session
    expect(again.id).toBe(first.id)
    const bruno1 = (await api('POST', `/api/tasks/${taskId}/terminal`, bruno.cookie)).json().session
    expect(bruno1.id).not.toBe(first.id)
  })
})
