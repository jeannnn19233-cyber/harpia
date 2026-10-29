import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import type { GitRunner } from '../src/projects/git.ts'

export interface TestServer {
  app: FastifyInstance
  ctx: AppContext
  dataDir: string
  close(): Promise<void>
}

export const fakeGit: GitRunner = {
  async clone() {},
  async currentBranch() {
    return 'main'
  }
}

export async function startServer(options: { git?: GitRunner; allowedOrigins?: string[] } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'harpia-test-'))
  const { app, ctx } = await buildApp({
    config: {
      dataDir,
      reposDir: join(dataDir, 'repos'),
      cookieSecure: false,
      webDir: null,
      allowedOrigins: options.allowedOrigins ?? []
    },
    git: options.git ?? fakeGit
  })
  await app.ready()
  return {
    app,
    ctx,
    dataDir,
    async close() {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

export function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((item) => item.name === 'harpia_session')
  if (!cookie) throw new Error('Resposta sem cookie de sessão.')
  return `harpia_session=${cookie.value}`
}

// Cria o administrador e devolve o cookie de sessão dele.
export async function setupAdmin(app: FastifyInstance): Promise<{ cookie: string; userId: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { name: 'Ana Admin', email: 'ana@exemplo.com', password: 'senha-forte-1' }
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  return { cookie: sessionCookie(response), userId: response.json().user.id }
}

// Convida e cadastra um membro, devolvendo o cookie de sessão dele.
export async function addMember(
  app: FastifyInstance,
  adminCookie: string,
  name: string,
  email: string
): Promise<{ cookie: string; userId: number }> {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: adminCookie }, payload: {} })
  const token = invite.json().invite.token
  const response = await app.inject({
    method: 'POST',
    url: `/api/invites/${token}/accept`,
    payload: { name, email, password: 'senha-forte-2' }
  })
  if (response.statusCode !== 200) throw new Error(response.body)
  return { cookie: sessionCookie(response), userId: response.json().user.id }
}
