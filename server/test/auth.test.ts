import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addMember, sessionCookie, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer

beforeEach(async () => {
  server = await startServer()
})

afterEach(async () => {
  await server.close()
})

describe('configuração inicial', () => {
  it('pede configuração enquanto não há usuários e cria o primeiro administrador', async () => {
    const before = await server.app.inject({ method: 'GET', url: '/api/status' })
    expect(before.json()).toEqual({ needsSetup: true })

    const { cookie } = await setupAdmin(server.app)
    const me = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.json().user).toMatchObject({ name: 'Ana Admin', role: 'admin' })

    const after = await server.app.inject({ method: 'GET', url: '/api/status' })
    expect(after.json()).toEqual({ needsSetup: false })
  })

  it('não deixa configurar duas vezes', async () => {
    await setupAdmin(server.app)
    const again = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { name: 'Outro', email: 'outro@exemplo.com', password: 'senha-forte-1' }
    })
    expect(again.statusCode).toBe(409)
  })
})

describe('login', () => {
  it('entra com a senha certa e recusa a errada', async () => {
    await setupAdmin(server.app)
    const wrong = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'ana@exemplo.com', password: 'errada' }
    })
    expect(wrong.statusCode).toBe(401)

    const right = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'ANA@exemplo.com', password: 'senha-forte-1' }
    })
    expect(right.statusCode).toBe(200)
    expect(sessionCookie(right)).toMatch(/^harpia_session=/)
  })

  it('bloqueia depois de muitas tentativas erradas', async () => {
    await setupAdmin(server.app)
    for (let i = 0; i < 10; i++) {
      await server.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'ana@exemplo.com', password: 'x' } })
    }
    const blocked = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: 'ana@exemplo.com', password: 'senha-forte-1' }
    })
    expect(blocked.statusCode).toBe(429)
  })

  it('sair invalida a sessão', async () => {
    const { cookie } = await setupAdmin(server.app)
    await server.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
    const me = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })

  it('exige login nas rotas da API', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/projects' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Faça login para continuar.')
  })

  it('bloqueia requisições vindas de outro site', async () => {
    const { cookie } = await setupAdmin(server.app)
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, origin: 'https://site-malicioso.com' },
      payload: { name: 'X', repoUrl: 'https://github.com/a/b.git' }
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('proxy na frente do Harpia', () => {
  it('aceita a origem configurada mesmo quando o Host é outro', async () => {
    await server.close()
    server = await startServer({ allowedOrigins: ['https://harpia.exemplo.ts.net'] })
    const { cookie } = await setupAdmin(server.app)
    const allowed = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, origin: 'https://harpia.exemplo.ts.net', host: '127.0.0.1:7420' },
      payload: { name: 'X', repoUrl: 'https://github.com/a/b.git' }
    })
    expect(allowed.statusCode).toBe(200)
    const blocked = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, origin: 'https://outro.exemplo.com', host: '127.0.0.1:7420' },
      payload: { name: 'Y', repoUrl: 'https://github.com/a/b.git' }
    })
    expect(blocked.statusCode).toBe(403)
  })
})

describe('convites', () => {
  it('só administradores criam convites', async () => {
    const admin = await setupAdmin(server.app)
    const member = await addMember(server.app, admin.cookie, 'Bruno', 'bruno@exemplo.com')
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: member.cookie },
      payload: {}
    })
    expect(response.statusCode).toBe(403)
  })

  it('cada convite serve uma vez só', async () => {
    const admin = await setupAdmin(server.app)
    const invite = await server.app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: admin.cookie }, payload: {} })
    const token = invite.json().invite.token

    const check = await server.app.inject({ method: 'GET', url: `/api/invites/${token}` })
    expect(check.json().invite.role).toBe('member')

    const first = await server.app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      payload: { name: 'Bruno', email: 'bruno@exemplo.com', password: 'senha-forte-2' }
    })
    expect(first.statusCode).toBe(200)

    const second = await server.app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      payload: { name: 'Carla', email: 'carla@exemplo.com', password: 'senha-forte-3' }
    })
    expect(second.statusCode).toBe(404)
  })

  it('lista a equipe', async () => {
    const admin = await setupAdmin(server.app)
    await addMember(server.app, admin.cookie, 'Bruno', 'bruno@exemplo.com')
    const response = await server.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } })
    expect(response.json().users.map((user: { name: string }) => user.name)).toEqual(['Ana Admin', 'Bruno'])
  })
})
