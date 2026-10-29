import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// O servidor guarda cada repositório como espelho (git clone --mirror). As cópias de
// trabalho de cada pessoa são clonadas desse espelho; só o espelho fala com o GitHub.
export interface GitRunner {
  clone(input: { repoUrl: string; destination: string }): Promise<void>
  fetch(repoPath: string): Promise<void>
  defaultBranch(repoPath: string): Promise<string>
  branchExists(repoPath: string, branch: string): Promise<boolean>
  // Traz para o espelho a branch empacotada (git bundle) na cópia de uma pessoa.
  importBundle(repoPath: string, bundlePath: string, branch: string): Promise<void>
  // Envia a branch do espelho para o repositório remoto (GitHub).
  push(repoPath: string, remoteUrl: string, branch: string): Promise<void>
  // Traz o commit de um PR (refs/pull/N/head) para o espelho, em refs/harpia/pull/N. Devolve o SHA.
  fetchPull(repoPath: string, number: number): Promise<string>
  // Diff do PR: da base comum com a branch principal até o commit do PR.
  diff(repoPath: string, base: string, sha: string): Promise<string>
  // Conteúdo de um arquivo numa branch do espelho; null se não existir.
  readFile(repoPath: string, branch: string, path: string): Promise<string | null>
  // Cria a branch "branch" a partir de "base" com um commit que grava um arquivo, sem cópia de
  // trabalho (o espelho não tem). Usado para levar um aprendizado ao AGENTS.md por PR.
  commitFile(
    repoPath: string,
    input: { base: string; branch: string; path: string; content: string; message: string; author: { name: string; email: string } }
  ): Promise<void>
  // Commits e alterações de uma branch feitos desde uma data (para o resumo da task). null se a branch não existe mais.
  branchWork(repoPath: string, branch: string, since: string): Promise<{ log: string; stat: string; diff: string } | null>
}

// Com HARPIA_GITHUB_TOKEN definido, o git usa esse token para repositórios privados do GitHub.
// O token chega ao git pela variável de ambiente, nunca pela linha de comando.
const TOKEN_HELPER = [
  '-c',
  'credential.https://github.com.helper=',
  '-c',
  'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$HARPIA_GITHUB_TOKEN"; }; f'
]

function run(args: string[], cwd?: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const auth = process.env.HARPIA_GITHUB_TOKEN ? TOKEN_HELPER : []
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...auth, ...args],
      {
        cwd,
        // Nunca abre prompt de senha: sem credencial configurada na VPS, falha logo.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file', ...extraEnv },
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout.trim())
      }
    )
  })
}

export const systemGit: GitRunner = {
  async clone({ repoUrl, destination }) {
    await run(['clone', '--mirror', '--', repoUrl, destination])
  },
  async fetch(repoPath) {
    await run(['fetch', '--prune', 'origin'], repoPath)
  },
  defaultBranch(repoPath) {
    return run(['symbolic-ref', '--short', 'HEAD'], repoPath)
  },
  async importBundle(repoPath, bundlePath, branch) {
    await run(['fetch', '--quiet', bundlePath, `+refs/heads/${branch}:refs/heads/${branch}`], repoPath)
  },
  async push(repoPath, remoteUrl, branch) {
    await run(['push', '--quiet', remoteUrl, `refs/heads/${branch}:refs/heads/${branch}`], repoPath)
  },
  async fetchPull(repoPath, number) {
    await run(['fetch', '--quiet', 'origin', `+refs/pull/${number}/head:refs/harpia/pull/${number}`], repoPath)
    return run(['rev-parse', `refs/harpia/pull/${number}`], repoPath)
  },
  async diff(repoPath, base, sha) {
    return run(['diff', '--no-color', '--no-ext-diff', '--find-renames', `refs/heads/${base}...${sha}`], repoPath)
  },
  async readFile(repoPath, branch, path) {
    try {
      return await run(['show', `refs/heads/${branch}:${path}`], repoPath)
    } catch {
      return null
    }
  },
  async commitFile(repoPath, input) {
    // Índice temporário: monta a árvore da base com o arquivo novo e cria o commit por cima.
    const dir = mkdtempSync(join(tmpdir(), 'harpia-index-'))
    const env = {
      GIT_INDEX_FILE: join(dir, 'index'),
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email
    }
    try {
      const base = await run(['rev-parse', `refs/heads/${input.base}`], repoPath)
      await run(['read-tree', base], repoPath, env)
      const blob = await new Promise<string>((resolve, reject) => {
        const child = execFile('git', ['hash-object', '-w', '--stdin'], { cwd: repoPath }, (error, stdout, stderr) =>
          error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())
        )
        child.stdin?.end(input.content)
      })
      await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${input.path}`], repoPath, env)
      const tree = await run(['write-tree'], repoPath, env)
      const commit = await run(['commit-tree', tree, '-p', base, '-m', input.message], repoPath, env)
      await run(['update-ref', `refs/heads/${input.branch}`, commit], repoPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  async branchWork(repoPath, branch, since) {
    const ref = `refs/heads/${branch}`
    try {
      await run(['rev-parse', '--verify', '--quiet', ref], repoPath)
    } catch {
      return null
    }
    const commits = (await run(['rev-list', '--reverse', `--since=${since}`, ref], repoPath)).split('\n').filter(Boolean)
    if (commits.length === 0) return { log: '', stat: '', diff: '' }
    const from = `${commits[0]}^`
    const [log, stat, diff] = await Promise.all([
      run(['log', '--no-color', '--format=- %s', `--since=${since}`, ref], repoPath),
      run(['diff', '--no-color', '--stat', from, ref], repoPath).catch(() => ''),
      run(['diff', '--no-color', '--no-ext-diff', from, ref], repoPath).catch(() => '')
    ])
    return { log, stat, diff }
  },
  async branchExists(repoPath, branch) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
      return true
    } catch {
      return false
    }
  }
}
