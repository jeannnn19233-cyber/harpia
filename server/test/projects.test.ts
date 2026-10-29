import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { systemGit } from '../src/projects/git.ts'
import { setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer | null = null
const cleanup: string[] = []

afterEach(async () => {
  await server?.close()
  server = null
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeLocalRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harpia-origin-'))
  cleanup.push(dir)
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    })
  git('init', '-q', '-b', branch)
  writeFileSync(join(dir, 'README.md'), '# teste\n')
  git('add', '.')
  git('commit', '-q', '-m', 'inicio')
  return dir
}

async function waitForStatus(cookie: string, id: number, statuses: string[]) {
  for (let i = 0; i < 100; i++) {
    const response = await server!.app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } })
    const project = response.json().project
    if (statuses.includes(project.cloneStatus)) return project
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('O clone não terminou a tempo.')
}

describe('projetos', () => {
  it('clona o repositório e descobre a branch principal', async () => {
    server = await startServer({ git: systemGit })
    const { cookie } = await setupAdmin(server.app)
    const origin = makeLocalRepo('trunk')

    const created = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Meu Projeto', repoUrl: origin }
    })
    expect(created.json().project).toMatchObject({ slug: 'meu-projeto', cloneStatus: 'pending' })

    const project = await waitForStatus(cookie, created.json().project.id, ['ready', 'error'])
    expect(project).toMatchObject({ cloneStatus: 'ready', defaultBranch: 'trunk', cloneError: null })
    // O servidor guarda um espelho (sem arquivos de trabalho) com as branches do repositório.
    const branches = execFileSync('git', ['branch', '--list'], { cwd: join(server.ctx.config.reposDir, 'meu-projeto') })
    expect(String(branches)).toContain('trunk')
    expect(existsSync(join(server.ctx.config.reposDir, 'meu-projeto', 'README.md'))).toBe(false)
  })

  it('avisa quando a branch informada não existe', async () => {
    server = await startServer({ git: systemGit })
    const { cookie } = await setupAdmin(server.app)
    const origin = makeLocalRepo('main')
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Branch errada', repoUrl: origin, defaultBranch: 'develop' }
    })
    const failed = await waitForStatus(cookie, created.json().project.id, ['ready', 'error'])
    expect(failed.cloneStatus).toBe('error')
    expect(failed.cloneError).toContain('develop')
  })

  it('mostra o erro quando o clone falha e permite tentar de novo', async () => {
    server = await startServer({ git: systemGit })
    const { cookie } = await setupAdmin(server.app)
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Quebrado', repoUrl: '/caminho/que/nao/existe' }
    })
    const failed = await waitForStatus(cookie, created.json().project.id, ['error'])
    expect(failed.cloneError).toBeTruthy()

    const retry = await server.app.inject({
      method: 'POST',
      url: `/api/projects/${failed.id}/clone`,
      headers: { cookie }
    })
    expect(retry.statusCode).toBe(200)
  })

  it('cria nomes únicos e recusa endereços suspeitos', async () => {
    server = await startServer()
    const { cookie } = await setupAdmin(server.app)
    const post = (payload: object) =>
      server!.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload })

    const a = await post({ name: 'Ação Rápida', repoUrl: 'https://github.com/a/b.git' })
    const b = await post({ name: 'Ação Rápida', repoUrl: 'https://github.com/a/c.git' })
    expect(a.json().project.slug).toBe('acao-rapida')
    expect(b.json().project.slug).toBe('acao-rapida-2')

    expect((await post({ name: 'X', repoUrl: '--upload-pack=touch /tmp/x' })).statusCode).toBe(400)
    expect((await post({ name: 'X', repoUrl: 'ext::sh -c touch% /tmp/x' })).statusCode).toBe(400)
    expect((await post({ name: 'X', repoUrl: 'https://github.com/a/b.git', defaultBranch: '--evil' })).statusCode).toBe(400)
  })
})
