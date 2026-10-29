import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp, type AppServices } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import type { AgentSystem } from '../src/agents/system.ts'
import type { ModelLister, ProviderFactory } from '../src/chat/providers/types.ts'
import type { GitHubClient } from '../src/github/client.ts'
import type { TelegramClient } from '../src/notify/telegram.ts'
import type { GitRunner } from '../src/projects/git.ts'
import { FakeAgentSystem } from './fake-agents.ts'

export interface TestServer {
  app: FastifyInstance
  ctx: AppContext
  services: AppServices
  dataDir: string
  close(keepData?: boolean): Promise<void>
}

// Por padrão, os testes nunca falam com o GitHub de verdade.
export const offlineGitHub: GitHubClient = {
  async listOpenPullRequests() {
    return []
  },
  async createReview() {
    throw new Error('Este teste não configurou o GitHub.')
  },
  async createPullRequest() {
    throw new Error('Este teste não configurou o GitHub.')
  },
  async findOpenPullRequest() {
    return null
  },
  async getPullRequest() {
    throw new Error('Este teste não configurou o GitHub.')
  }
}

export const fakeGit: GitRunner = {
  async clone() {},
  async fetch() {},
  async defaultBranch() {
    return 'main'
  },
  async branchExists() {
    return true
  },
  async importBundle() {},
  async push() {},
  async fetchPull() {
    return 'abc123'
  },
  async diff() {
    return ''
  }
}

export async function startServer(
  options: {
    git?: GitRunner
    agents?: AgentSystem
    chatProviders?: ProviderFactory
    chatModels?: ModelLister
    github?: GitHubClient
    telegram?: TelegramClient
    now?: () => Date
    dataDir?: string
    allowedOrigins?: string[]
    setupCode?: string
    terminalsEnabled?: boolean
    maxSessionsPerUser?: number
    routineLimits?: { inactivityMs?: number; maxMs?: number }
  } = {}
): Promise<TestServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'harpia-test-'))
  const { app, ctx, services } = await buildApp({
    config: {
      dataDir,
      reposDir: join(dataDir, 'repos'),
      cookieSecure: false,
      webDir: null,
      allowedOrigins: options.allowedOrigins ?? [],
      setupCode: options.setupCode ?? null,
      terminalsEnabled: options.terminalsEnabled ?? false,
      maxSessionsPerUser: options.maxSessionsPerUser ?? 5,
      prPollSeconds: 3600,
      watcherIntervalSeconds: 3600,
      routineTickSeconds: 0,
      maxConcurrentRuns: 3,
      reviewPollSeconds: 0,
      reviewSettleSeconds: 0,
      vaultSyncSeconds: 0,
      staleHours: 48,
      reviewHours: 24
    },
    telegram: options.telegram ?? null,
    pollTelegram: false,
    now: options.now,
    github: options.github ?? offlineGitHub,
    git: options.git ?? fakeGit,
    agents: options.agents ?? new FakeAgentSystem(),
    chatModels: options.chatModels,
    routineLimits: options.routineLimits,
    chatProviders: options.chatProviders ?? (() => {
      throw new Error('Este teste não configurou provedores de chat.')
    })
  })
  await app.ready()
  return {
    app,
    ctx,
    services,
    dataDir,
    async close(keepData = false) {
      await app.close()
      if (!keepData) rmSync(dataDir, { recursive: true, force: true })
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
