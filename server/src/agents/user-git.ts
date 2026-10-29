import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangedFile, Project, Task, User } from '../../../shared/types.ts'
import { slugify } from '../projects/store.ts'
import { parseChangedFiles } from './changes.ts'

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
  async prepareWorktree(input: { user: User; project: Project; task: Task; mirrorPath: string }) {
    const { user, project, task, mirrorPath } = input
    const clone = join(this.home, 'projects', project.slug)
    if (existsSync(join(clone, '.git'))) {
      await this.git(clone, 'fetch', '--quiet', '--prune', 'origin')
    } else {
      await this.run(['mkdir', '-p', dirname(clone)])
      await this.run(['git', 'clone', '--quiet', '--no-checkout', mirrorPath, clone])
    }

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
