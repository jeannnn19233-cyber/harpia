import { afterEach, beforeEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { RealtimeMessage } from '../../shared/types.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let baseUrl: string

beforeEach(async () => {
  server = await startServer()
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  const address = server.app.server.address()
  if (!address || typeof address === 'string') throw new Error('Sem endereço.')
  baseUrl = `127.0.0.1:${address.port}`
})

afterEach(async () => {
  await server.close()
})

function connect(cookie: string, origin?: string): Promise<{ socket: WebSocket; messages: RealtimeMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${baseUrl}/api/ws`, { headers: { cookie, ...(origin ? { origin } : {}) } })
    const messages: RealtimeMessage[] = []
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    socket.on('open', () => resolve({ socket, messages }))
    socket.on('error', reject)
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Mensagem não chegou.')
}

it('mostra quem está online e transmite mudanças nas tasks para a equipe', async () => {
  const admin = await setupAdmin(server.app)
  const bruno = await addMember(server.app, admin.cookie, 'Bruno', 'bruno@exemplo.com')

  const adminConn = await connect(admin.cookie)
  const brunoConn = await connect(bruno.cookie)
  await waitFor(() =>
    adminConn.messages.some((m) => m.type === 'presence' && m.userIds.length === 2)
  )

  const project = await server.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: admin.cookie },
    payload: { name: 'Loja', repoUrl: 'https://github.com/a/b.git' }
  })
  await server.app.inject({
    method: 'POST',
    url: `/api/projects/${project.json().project.id}/tasks`,
    headers: { cookie: admin.cookie },
    payload: { title: 'Carrinho' }
  })

  await waitFor(() => brunoConn.messages.some((m) => m.type === 'task' && m.task.title === 'Carrinho'))
  await waitFor(() => brunoConn.messages.some((m) => m.type === 'task_event' && m.event.type === 'created'))

  brunoConn.socket.close()
  await waitFor(() => {
    const last = adminConn.messages.filter((m) => m.type === 'presence').at(-1)
    return last?.type === 'presence' && last.userIds.length === 1
  })
  adminConn.socket.close()
})

it('recusa conexões sem login ou de outro site', async () => {
  await expect(connect('')).rejects.toThrow('HTTP 401')
  const admin = await setupAdmin(server.app)
  await expect(connect(admin.cookie, 'https://site-malicioso.com')).rejects.toThrow('HTTP 403')
})
