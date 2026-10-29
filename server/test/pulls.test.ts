import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Task, User } from '../../shared/types.ts'
import { UserGit } from '../src/agents/user-git.ts'
import type { GitHubClient, PullRequestInfo } from '../src/github/client.ts'
import { systemGit, type GitRunner } from '../src/projects/git.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

const GITHUB_URL = 'https://github.com/clarumi/loja.git'
const identity = {
  GIT_AUTHOR_NAME: 'Teste',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'Teste',
  GIT_COMMITTER_EMAIL: 't@t'
}

// Agentes de teste que usam git de verdade, rodando como o usuário atual.
class LocalGitAgents extends FakeAgentSystem {
  readonly root: string

  constructor(root: string) {
    super()
    this.root = root
  }

  private git(user: User): UserGit {
    const home = join(this.root, 'homes', String(user.id))
    mkdirSync(home, { recursive: true })
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const [command, ...rest] = args
        execFile(command, rest, { env: { ...process.env, ...identity } }, (error, stdout, stderr) =>
          error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())
        )
      })
    return new UserGit(run, home)
  }

  override async prepareWorktree(input: { user: User; project: Project; task: Task; mirrorPath: string }) {
    return this.git(input.user).prepareWorktree(input)
  }
  override changedFiles(input: { user: User; path: string; base: string }) {
    return this.git(input.user).changedFiles(input.path, input.base)
  }
  override hasUncommittedChanges(input: { user: User; path: string }) {
    return this.git(input.user).hasUncommittedChanges(input.path)
  }
  override commitAll(input: { user: User; path: string; message: string }) {
    return this.git(input.user).commitAll(input.path, input.message)
  }
  override commitsAhead(input: { user: User; path: string; base: string }) {
    return this.git(input.user).commitsAhead(input.path, input.base)
  }
  override exportBranch(input: { user: User; path: string; branch: string }) {
    return this.git(input.user).exportBranch(input.path, input.branch)
  }
}

// GitHub de mentira: guarda os PRs criados e deixa o teste decidir o estado de cada um.
class FakeGitHub implements GitHubClient {
  readonly created: { title: string; head: string; base: string; body: string }[] = []
  readonly states = new Map<number, Omit<PullRequestInfo, 'number' | 'url'>>()

  async createPullRequest(_repo: unknown, input: { title: string; body: string; head: string; base: string }) {
    this.created.push(input)
    const number = 10 + this.created.length
    this.states.set(number, { state: 'open', merged: false })
    return { number, url: `https://github.com/clarumi/loja/pull/${number}`, state: 'open' as const, merged: false }
  }
  async findOpenPullRequest() {
    return null
  }
  async getPullRequest(_repo: unknown, number: number) {
    return { number, url: `https://github.com/clarumi/loja/pull/${number}`, ...this.states.get(number)! }
  }
}

let root: string
let remote: string
let server: TestServer
let agents: LocalGitAgents
let github: FakeGitHub
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let taskId: number

const remoteGit = (...args: string[]) => String(execFileSync('git', ['-C', remote, ...args])).trim()

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (method === 'GET' ? undefined : {}) })
}

// Abre o terminal da pessoa na task, o que cria a cópia de trabalho dela, e devolve o caminho.
async function worktreeOf(person: { cookie: string; userId: number }): Promise<string> {
  await api('POST', `/api/tasks/${taskId}/terminal`, person.cookie)
  return join(root, 'homes', String(person.userId), 'worktrees', 'loja', 'T-1')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harpia-pr-'))
  // O "GitHub": um repositório bare com a branch main.
  const seed = join(root, 'seed')
  mkdirSync(seed)
  const seedGit = (...args: string[]) => execFileSync('git', args, { cwd: seed, env: { ...process.env, ...identity } })
  seedGit('init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'README.md'), '# loja\n')
  seedGit('add', '.')
  seedGit('commit', '-q', '-m', 'inicio')
  remote = join(root, 'github.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, remote])

  // Git real, com o endereço do GitHub trocado pelo repositório local.
  const git: GitRunner = {
    ...systemGit,
    clone: ({ destination }) => systemGit.clone({ repoUrl: remote, destination }),
    push: (repoPath, _url, branch) => systemGit.push(repoPath, remote, branch)
  }
  agents = new LocalGitAgents(root)
  github = new FakeGitHub()
  server = await startServer({ agents, git, github, terminalsEnabled: true })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  const project = (await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: GITHUB_URL })).json().project
  for (let i = 0; i < 100; i++) {
    if ((await api('GET', `/api/projects/${project.id}`, ana.cookie)).json().project.cloneStatus === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  taskId = (await api('POST', `/api/projects/${project.id}/tasks`, ana.cookie, { title: 'Checkout com Pix' })).json().task.id
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('pull requests', () => {
  it('mostra as alterações, faz o commit, envia a branch e abre o PR', async () => {
    const path = await worktreeOf(ana)
    writeFileSync(join(path, 'checkout.ts'), 'export const pix = true\n')
    writeFileSync(join(path, 'README.md'), '# loja\n\nAgora com Pix.\n')

    const changes = (await api('GET', `/api/tasks/${taskId}/changes`, ana.cookie)).json()
    expect(changes).toMatchObject({ hasWorktree: true, uncommitted: true, branch: `harpia/T-1-ana-${ana.userId}` })
    // Em ordem alfabética, sem diferenciar maiúsculas.
    expect(changes.files).toEqual([
      { path: 'checkout.ts', status: '?', additions: null, deletions: null },
      { path: 'README.md', status: 'M', additions: 2, deletions: 0 }
    ])

    const response = await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, {
      title: 'Checkout com Pix',
      body: 'Adiciona o Pix.'
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ created: true, pullRequest: { number: 11, state: 'open', base: 'main' } })

    // A branch chegou ao "GitHub" com o commit e os arquivos.
    const branch = `harpia/T-1-ana-${ana.userId}`
    expect(remoteGit('log', '-1', '--format=%s', branch)).toBe('T-1: Checkout com Pix')
    expect(remoteGit('show', `${branch}:checkout.ts`)).toBe('export const pix = true')
    expect(github.created[0]).toMatchObject({ title: 'Checkout com Pix', head: branch, base: 'main' })
    expect(github.created[0].body).toContain('Aberto pelo Harpia')

    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task.status).toBe('review')
    // Abrir o PR coloca a pessoa na task e leva a task para revisão.
    expect(detail.events.map((event: { type: string }) => event.type).slice(-3)).toEqual([
      'pr_opened',
      'participant_joined',
      'status_changed'
    ])
    expect(detail.task.participantIds).toContain(ana.userId)
  })

  it('novas alterações vão para o mesmo PR', async () => {
    const path = await worktreeOf(ana)
    writeFileSync(join(path, 'a.ts'), '1\n')
    await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, { title: 'Checkout' })
    writeFileSync(join(path, 'b.ts'), '2\n')
    const second = await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, {
      title: 'Checkout',
      commitMessage: 'T-1: arquivo b'
    })
    expect(second.json()).toMatchObject({ created: false, pullRequest: { number: 11 } })
    expect(github.created).toHaveLength(1)
    expect(remoteGit('log', '-1', '--format=%s', `harpia/T-1-ana-${ana.userId}`)).toBe('T-1: arquivo b')
    const events = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json().events
    expect(events.at(-1)).toMatchObject({ type: 'pr_updated', data: { number: 11 } })
  })

  it('sem alterações não abre PR', async () => {
    await worktreeOf(ana)
    const response = await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, { title: 'Nada' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Não há alterações para enviar.')
  })

  it('pede uma cópia de trabalho antes', async () => {
    const response = await api('POST', `/api/tasks/${taskId}/pull-requests`, bruno.cookie, { title: 'x' })
    expect(response.statusCode).toBe(409)
  })

  it('com o merge, a task vai sozinha para "Feito"; antes disso, não dá para fechar na mão', async () => {
    const path = await worktreeOf(ana)
    writeFileSync(join(path, 'a.ts'), '1\n')
    await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, { title: 'Checkout' })

    const manual = await api('PATCH', `/api/tasks/${taskId}`, ana.cookie, { status: 'done' })
    expect(manual.statusCode).toBe(409)
    expect(manual.json().error).toContain('#11')

    github.states.set(11, { state: 'closed', merged: true })
    const refreshed = await api('POST', `/api/tasks/${taskId}/pull-requests/refresh`, ana.cookie)
    expect(refreshed.json().pullRequests[0].state).toBe('merged')

    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task.status).toBe('done')
    expect(detail.task.closedAt).not.toBeNull()
    expect(detail.events.slice(-2)).toMatchObject([
      { type: 'pr_merged', actorId: null, data: { number: 11 } },
      { type: 'status_changed', data: { to: 'done', reason: 'merged' } }
    ])
  })

  it('com duas pessoas, a task só fecha quando todos os PRs tiverem merge', async () => {
    writeFileSync(join(await worktreeOf(ana), 'front.ts'), 'front\n')
    writeFileSync(join(await worktreeOf(bruno), 'back.ts'), 'back\n')
    await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, { title: 'Front' })
    await api('POST', `/api/tasks/${taskId}/pull-requests`, bruno.cookie, { title: 'Back' })
    expect(github.created.map((pr) => pr.head)).toEqual([`harpia/T-1-ana-${ana.userId}`, `harpia/T-1-bruno-${bruno.userId}`])

    github.states.set(11, { state: 'closed', merged: true })
    await api('POST', `/api/tasks/${taskId}/pull-requests/refresh`, ana.cookie)
    expect((await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json().task.status).toBe('review')

    github.states.set(12, { state: 'closed', merged: true })
    await api('POST', `/api/tasks/${taskId}/pull-requests/refresh`, ana.cookie)
    expect((await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json().task.status).toBe('done')
  })

  it('PR fechado sem merge fica registrado e a task continua aberta', async () => {
    writeFileSync(join(await worktreeOf(ana), 'a.ts'), '1\n')
    await api('POST', `/api/tasks/${taskId}/pull-requests`, ana.cookie, { title: 'Checkout' })
    github.states.set(11, { state: 'closed', merged: false })
    await api('POST', `/api/tasks/${taskId}/pull-requests/refresh`, ana.cookie)
    const detail = (await api('GET', `/api/tasks/${taskId}`, ana.cookie)).json()
    expect(detail.task.status).toBe('review')
    expect(detail.events.at(-1)).toMatchObject({ type: 'pr_closed', data: { number: 11 } })
    // Sem PR aberto, a equipe volta a poder fechar a task na mão.
    expect((await api('PATCH', `/api/tasks/${taskId}`, ana.cookie, { status: 'done' })).statusCode).toBe(200)
  })
})

describe('endereço do GitHub', () => {
  it('reconhece os formatos de endereço e recusa outros servidores', async () => {
    const { parseGitHubRepo } = await import('../src/github/client.ts')
    expect(parseGitHubRepo('https://github.com/clarumi/loja.git')).toEqual({ owner: 'clarumi', name: 'loja' })
    expect(parseGitHubRepo('https://github.com/clarumi/loja')).toEqual({ owner: 'clarumi', name: 'loja' })
    expect(parseGitHubRepo('git@github.com:clarumi/loja.git')).toEqual({ owner: 'clarumi', name: 'loja' })
    expect(parseGitHubRepo('ssh://git@github.com/clarumi/loja.git')).toEqual({ owner: 'clarumi', name: 'loja' })
    expect(parseGitHubRepo('https://gitlab.com/clarumi/loja.git')).toBeNull()
  })
})
