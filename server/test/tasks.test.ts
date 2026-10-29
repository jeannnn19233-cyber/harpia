import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let admin: { cookie: string; userId: number }
let projectId: number

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload })
}

async function createTask(title: string, cookie = admin.cookie) {
  const response = await api('POST', `/api/projects/${projectId}/tasks`, cookie, { title })
  expect(response.statusCode).toBe(200)
  return response.json().task
}

beforeEach(async () => {
  server = await startServer()
  admin = await setupAdmin(server.app)
  const project = await api('POST', '/api/projects', admin.cookie, {
    name: 'Loja Online',
    repoUrl: 'https://github.com/exemplo/loja.git'
  })
  projectId = project.json().project.id
})

afterEach(async () => {
  await server.close()
})

describe('tasks', () => {
  it('numera as tasks por projeto e começa no backlog', async () => {
    const first = await createTask('Tela de login')
    const second = await createTask('API de pedidos')
    expect(first).toMatchObject({ number: 1, status: 'backlog', ownerId: null })
    expect(second.number).toBe(2)
    expect(second.position).toBeGreaterThan(first.position)
  })

  it('quem move uma task sem responsável para "Em andamento" vira o responsável', async () => {
    const task = await createTask('Tela de login')
    const moved = await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { status: 'in_progress' })
    expect(moved.json().task).toMatchObject({
      status: 'in_progress',
      ownerId: admin.userId,
      participantIds: [admin.userId]
    })
    expect(moved.json().events.map((event: { type: string }) => event.type)).toEqual([
      'status_changed',
      'owner_changed',
      'participant_joined'
    ])
  })

  it('marca a data de conclusão ao ir para "Feito" e limpa ao reabrir', async () => {
    const task = await createTask('Tela de login')
    const done = await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { status: 'done' })
    expect(done.json().task.closedAt).not.toBeNull()
    const reopened = await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { status: 'review' })
    expect(reopened.json().task.closedAt).toBeNull()
  })

  it('várias pessoas participam da mesma task', async () => {
    const bruno = await addMember(server.app, admin.cookie, 'Bruno', 'bruno@exemplo.com')
    const task = await createTask('Checkout')
    await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { ownerId: admin.userId })
    const joined = await api('POST', `/api/tasks/${task.id}/join`, bruno.cookie)
    expect(joined.json().task.participantIds).toEqual([admin.userId, bruno.userId])

    const left = await api('POST', `/api/tasks/${task.id}/leave`, bruno.cookie)
    expect(left.json().task.participantIds).toEqual([admin.userId])
  })

  it('o responsável não sai da task sem passar a vez', async () => {
    const task = await createTask('Checkout')
    await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { ownerId: admin.userId })
    const left = await api('POST', `/api/tasks/${task.id}/leave`, admin.cookie)
    expect(left.statusCode).toBe(409)
  })

  it('registra tudo no histórico da task, incluindo comentários', async () => {
    const task = await createTask('Checkout')
    await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { title: 'Checkout com Pix', description: 'Detalhes' })
    await api('POST', `/api/tasks/${task.id}/comments`, admin.cookie, { body: 'Vou começar pelo back.' })

    const detail = await api('GET', `/api/tasks/${task.id}`, admin.cookie)
    const events = detail.json().events
    expect(events.map((event: { type: string }) => event.type)).toEqual(['created', 'edited', 'comment'])
    expect(events[1].data).toEqual({ fields: ['title', 'description'] })
    expect(events[2].data).toEqual({ body: 'Vou começar pelo back.' })
    expect(detail.json().task.lastActivityAt).toBe(events[2].createdAt)
  })

  it('recusa responsável inexistente e status inválido', async () => {
    const task = await createTask('Checkout')
    const badOwner = await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { ownerId: 999 })
    expect(badOwner.statusCode).toBe(400)
    const badStatus = await api('PATCH', `/api/tasks/${task.id}`, admin.cookie, { status: 'qualquer' })
    expect(badStatus.statusCode).toBe(400)
  })

  it('lista as tasks do projeto', async () => {
    await createTask('A')
    await createTask('B')
    const list = await api('GET', `/api/projects/${projectId}/tasks`, admin.cookie)
    expect(list.json().tasks.map((task: { title: string }) => task.title)).toEqual(['A', 'B'])
  })
})
