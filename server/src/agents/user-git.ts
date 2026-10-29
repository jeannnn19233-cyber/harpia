import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangedFile, Project, Task, User } from '../../../shared/types.ts'
import { slugify } from '../projects/store.ts'
import { parseChangedFiles } from './changes.ts'

// Branch local da cópia de revisão de um PR.
export function reviewBranch(number: number): string {
  return `harpia-revisao/pr-${number}`
}

// Roda um comando como a pessoa (na VPS, via runuser; nos testes, direto).
export type RunAsUser = (args: string[]) => Promise<string>

// Operações de git na cópia de trabalho de cada pessoa. Nunca rodam como root.
export class UserGit {
  private readonly run: RunAsUser
  private readonly home: string

  constructor(run: RunAsUser, home: string) {
    this.run = run
    this.home = home
  }

  private git(path: string, ...args: string[]): Promise<string> {
    return this.run(['git', '-C', path, ...args])
  }

  // Clona o espelho para a pasta da pessoa (uma vez por projeto) e cria a worktree da task
  // numa branch só dela, a partir da branch principal.
  private async ensureClone(project: Project, mirrorPath: string): Promise<string> {
    const clone = join(this.home, 'projects', project.slug)
    if (existsSync(join(clone, '.git'))) {
      await this.git(clone, 'fetch', '--quiet', '--prune', 'origin')
    } else {
      await this.run(['mkdir', '-p', dirname(clone)])
      await this.run(['git', 'clone', '--quiet', '--no-checkout', mirrorPath, clone])
    }
    return clone
  }

  // Cópia do commit de um PR para o revisor, na branch local "harpia-revisao/pr-N" (onde ele pode
  // commitar as correções). Recriada a cada execução, sempre limpa. node_modules fica guardado
  // ao lado e volta para a cópia nova, para não instalar tudo de novo a cada revisão.
  async prepareReviewCheckout(input: { project: Project; mirrorPath: string; number: number; sha: string }): Promise<string> {
    const clone = await this.ensureClone(input.project, input.mirrorPath)
    // Todos os PRs abertos que o espelho já buscou, para comparar com os irmãos (regra 10).
    await this.git(clone, 'fetch', '--quiet', 'origin', '+refs/harpia/pull/*:refs/harpia/pull/*')
    const path = join(this.home, 'revisoes', input.project.slug, `pr-${input.number}`)
    const cache = join(this.home, 'revisoes', input.project.slug, '.node_modules')
    if (existsSync(path)) {
      if (existsSync(join(path, 'node_modules')) && !existsSync(cache)) await this.run(['mv', join(path, 'node_modules'), cache])
      await this.git(clone, 'worktree', 'remove', '--force', path).catch(() => undefined)
      await this.run(['rm', '-rf', path])
    }
    await this.git(clone, 'worktree', 'prune')
    await this.run(['mkdir', '-p', dirname(path)])
    await this.git(clone, 'worktree', 'add', '--quiet', '-B', reviewBranch(input.number), path, input.sha)
    if (existsSync(cache)) await this.run(['mv', cache, join(path, 'node_modules')])
    return path
  }

  // HEAD da cópia e os commits feitos depois de "from" (o que o revisor vai enviar).
  async branchLog(path: string, from: string): Promise<{ head: string; commits: { sha: string; message: string; files: string[] }[] }> {
    const head = await this.git(path, 'rev-parse', 'HEAD')
    const shas = (await this.git(path, 'rev-list', '--reverse', `${from}..HEAD`)).split('\n').filter(Boolean)
    const commits = []
    for (const sha of shas) {
      commits.push({
        sha,
        message: await this.git(path, 'log', '-1', '--format=%B', sha),
        files: (await this.git(path, 'show', '--name-only', '--format=', sha)).split('\n').filter(Boolean)
      })
    }
    return { head, commits }
  }

  async prepareWorktree(input: { user: User; project: Project; task: Task; mirrorPath: string }) {
    const { user, project, task, mirrorPath } = input
    const clone = await this.ensureClone(project, mirrorPath)

    const firstName = slugify(user.name.split(/\s+/)[0] ?? 'pessoa')
    const branch = `harpia/T-${task.number}-${firstName}-${user.id}`
    const path = join(this.home, 'worktrees', project.slug, `T-${task.number}`)
    if (existsSync(path)) return { path, branch }

    await this.git(clone, 'worktree', 'prune')
    await this.run(['mkdir', '-p', dirname(path)])
    let branchExists = true
    try {
      await this.git(clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
    } catch {
      branchExists = false
    }
    // Se a branch já existe (a pasta foi apagada), reaproveita sem perder commits.
    const args = branchExists
      ? ['worktree', 'add', '--quiet', path, branch]
      : ['worktree', 'add', '--quiet', '-b', branch, path, `origin/${project.defaultBranch}`]
    await this.git(clone, ...args)
    return { path, branch }
  }

  async changedFiles(path: string, base: string): Promise<ChangedFile[]> {
    await this.git(path, 'fetch', '--quiet', 'origin').catch(() => undefined)
    const mergeBase = await this.git(path, 'merge-base', `origin/${base}`, 'HEAD')
    const [nameStatus, numstat, untracked] = await Promise.all([
      this.git(path, 'diff', '--no-renames', '--name-status', mergeBase),
      this.git(path, 'diff', '--no-renames', '--numstat', mergeBase),
      this.git(path, 'ls-files', '--others', '--exclude-standard')
    ])
    return parseChangedFiles({ nameStatus, numstat, untracked })
  }

  async hasUncommittedChanges(path: string): Promise<boolean> {
    return (await this.git(path, 'status', '--porcelain')).length > 0
  }

  async commitAll(path: string, message: string): Promise<void> {
    await this.git(path, 'add', '-A')
    await this.git(path, 'commit', '--quiet', '-m', message)
  }

  async commitsAhead(path: string, base: string): Promise<number> {
    await this.git(path, 'fetch', '--quiet', 'origin').catch(() => undefined)
    return Number(await this.git(path, 'rev-list', '--count', `origin/${base}..HEAD`))
  }

  // Empacota a branch num arquivo que o servidor importa no espelho, sem precisar entrar
  // no repositório da pessoa.
  async exportBranch(path: string, branch: string): Promise<string> {
    const dir = join(this.home, '.harpia-export')
    const file = join(dir, `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.bundle`)
    await this.run(['mkdir', '-p', dir])
    await this.git(path, 'bundle', 'create', '--quiet', file, `refs/heads/${branch}`)
    return file
  }
}
