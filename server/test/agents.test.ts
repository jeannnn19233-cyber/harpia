import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let agents: FakeAgentSystem
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let taskId: number

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload })
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

async function start(options: { terminalsEnabled?: boolean; maxSessionsPerUser?: number } = {}) {
  agents = new FakeAgentSystem()
  server = await startServer({ agents, terminalsEnabled: options.terminalsEnabled ?? true, ...options })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  const project = await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: 'https://github.com/a/b.git' })
  const projectId = project.json().project.id
  await waitFor(async () => (await api('GET', `/api/projects/${projectId}`, ana.cookie)).json().project.cloneStatus === 'ready')
  const task = await api('POST', `/api/projects/${projectId}/tasks`, ana.cookie, { title: 'Checkout' })
  taskId = task.json().task.id
}

afterEach(async () => {
  await server.close()
})

describe('terminais desligados', () => {
  beforeEach(() => start({ terminalsEnabled: false }))

  it('explica como ligar e recusa abrir agentes', async () => {
    const status = await api('GET', '/api/agents/status', ana.cookie)
    expect(status.json().enabled).toBe(false)
    expect(status.json().reason).toContain('HARPIA_TERMINALS=on')

    const response = await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'claude' })
    expect(response.statusCode).toBe(503)
  })
})

describe('agentes nas tasks', () => {
  beforeEach(() => start())

  it('mostra o motivo quando o servidor não consegue rodar terminais', async () => {
    agents.reason = 'Terminais só funcionam com o servidor do Harpia em Linux.'
    const status = await api('GET', '/api/agents/status', ana.cookie)
    expect(status.json()).toEqual({ enabled: false, reason: agents.reason })
  })

  it('abre o Claude Code na cópia de trabalho da pessoa e registra na task', async () => {
    const response = await api('POST', `/api/tasks/${taskId}/sessions`, bruno.cookie, { kind: 'claude' })
    expect(response.statusCode).toBe(200)
    const session = response.json().session
    expect(session).toMatchObject({ taskId, userId: bruno.userId, kind: 'claude', status: 'running' })
    expect(session.branch).toBe(`harpia/T-1-u${bruno.userId}`)
    expect(session).not.toHaveProperty('cwd')

    const running = agents.running.get(`harpia-${session.id}`)
    expect(running).toMatchObject({ user: bruno.userId, command: 'claude; exec bash -l' })
    expect(running?.cwd).toBe(`/fake/${bruno.userId}/loja/T-1`)

    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task.participantIds).toContain(bruno.userId)
    expect(detail.events.map((event: { type: string }) => event.type)).toEqual([
      'created',
      'status_changed',
      'owner_changed',
      'participant_joined',
      'agent_started'
    ])
    // Abrir um agente tira a task do Backlog e define o responsável.
    expect(detail.task).toMatchObject({ status: 'in_progress', ownerId: bruno.userId })

    const list = await api('GET', `/api/tasks/${taskId}/sessions`, ana.cookie)
    expect(list.json().sessions).toHaveLength(1)
  })

  it('não muda status nem responsável de task que já está andando', async () => {
    await api('PATCH', `/api/tasks/${taskId}`, ana.cookie, { status: 'review', ownerId: ana.userId })
    await api('POST', `/api/tasks/${taskId}/sessions`, bruno.cookie, { kind: 'codex' })
    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task).toMatchObject({ status: 'review', ownerId: ana.userId })
  })

  it('cada pessoa abre o próprio agente na mesma task', async () => {
    await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'codex' })
    await api('POST', `/api/tasks/${taskId}/sessions`, bruno.cookie, { kind: 'claude' })
    const sessions = (await api('GET', `/api/tasks/${taskId}/sessions`, ana.cookie)).json().sessions
    expect(sessions.map((s: { userId: number; kind: string }) => [s.userId, s.kind])).toEqual([
      [ana.userId, 'codex'],
      [bruno.userId, 'claude']
    ])
  })

  it('limita quantas sessões cada pessoa abre ao mesmo tempo', async () => {
    await server.close()
    await start({ maxSessionsPerUser: 1 })
    expect((await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'shell' })).statusCode).toBe(200)
    const second = await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'shell' })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toContain('1 sessões')
  })

  it('lista as sessões abertas de todas as tasks, sem o terminal pessoal', async () => {
    await api('POST', '/api/me/terminal', ana.cookie)
    const opened = (await api('POST', `/api/tasks/${taskId}/sessions`, bruno.cookie, { kind: 'codex' })).json().session
    const running = (await api('GET', '/api/sessions/running', ana.cookie)).json().sessions
    expect(running.map((s: { id: number }) => s.id)).toEqual([opened.id])
  })

  it('não abre agentes em task concluída', async () => {
    await api('PATCH', `/api/tasks/${taskId}`, ana.cookie, { status: 'done' })
    const response = await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'claude' })
    expect(response.statusCode).toBe(409)
  })

  it('só quem abriu (ou um admin) encerra a sessão', async () => {
    const session = (await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'claude' })).json().session
    const denied = await api('POST', `/api/sessions/${session.id}/stop`, bruno.cookie)
    expect(denied.statusCode).toBe(403)

    const stopped = await api('POST', `/api/sessions/${session.id}/stop`, ana.cookie)
    expect(stopped.json().session.status).toBe('exited')
    expect(agents.running.size).toBe(0)
    const events = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json().events
    expect(events.at(-1)).toMatchObject({ type: 'agent_stopped', data: { reason: 'stopped', kind: 'claude' } })
  })

  it('o terminal pessoal é reaproveitado enquanto estiver aberto', async () => {
    const first = (await api('POST', '/api/me/terminal', ana.cookie)).json().session
    expect(first).toMatchObject({ kind: 'account', taskId: null })
    const again = (await api('POST', '/api/me/terminal', ana.cookie)).json().session
    expect(again.id).toBe(first.id)

    agents.running.clear()
    const fresh = (await api('POST', '/api/me/terminal', ana.cookie)).json().session
    expect(fresh.id).not.toBe(first.id)
  })

  it('mostra quais contas de IA a pessoa já conectou', async () => {
    agents.accountsByUser.set(ana.userId, { claude: true, codex: false })
    const response = await api('GET', '/api/me/accounts', ana.cookie)
    expect(response.json().accounts).toEqual({ claude: true, codex: false })
  })
})

describe('terminal ao vivo', () => {
  let baseUrl: string

  beforeEach(async () => {
    await start()
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    const address = server.app.server.address()
    if (!address || typeof address === 'string') throw new Error('Sem endereço.')
    baseUrl = `ws://127.0.0.1:${address.port}`
  })

  function open(path: string, cookie: string): Promise<{ socket: WebSocket; output: string[]; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}${path}`, { headers: { cookie } })
      const output: string[] = []
      const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)))
      socket.on('message', (data) => output.push(String(data)))
      socket.on('open', () => resolve({ socket, output, closed }))
      socket.on('error', reject)
    })
  }

  it('quem abriu digita; o resto da equipe só assiste', async () => {
    const session = (await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'claude' })).json().session
    const owner = await open(`/api/sessions/${session.id}/terminal?cols=100&rows=30`, ana.cookie)
    const viewer = await open(`/api/sessions/${session.id}/terminal`, bruno.cookie)
    await waitFor(() => owner.output.length > 0 && viewer.output.length > 0)

    expect(agents.attached).toEqual([
      { name: `harpia-${session.id}`, readOnly: false },
      { name: `harpia-${session.id}`, readOnly: true }
    ])

    owner.socket.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    viewer.socket.send(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }))
    await waitFor(() => agents.written.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agents.written.map((item) => item.data)).toEqual(['ls\r'])

    owner.socket.close()
    viewer.socket.close()
  })

  it('ninguém vê o terminal pessoal de outra pessoa', async () => {
    const session = (await api('POST', '/api/me/terminal', ana.cookie)).json().session
    const intruder = await open(`/api/sessions/${session.id}/terminal`, bruno.cookie)
    expect(await intruder.closed).toBe(4403)
  })

  it('fecha a conexão de sessões encerradas', async () => {
    const session = (await api('POST', `/api/tasks/${taskId}/sessions`, ana.cookie, { kind: 'shell' })).json().session
    await api('POST', `/api/sessions/${session.id}/stop`, ana.cookie)
    const late = await open(`/api/sessions/${session.id}/terminal`, ana.cookie)
    expect(await late.closed).toBe(4410)
  })
})
