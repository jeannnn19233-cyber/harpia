import { execFile } from 'node:child_process'

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
}

// Com HARPIA_GITHUB_TOKEN definido, o git usa esse token para repositórios privados do GitHub.
// O token chega ao git pela variável de ambiente, nunca pela linha de comando.
const TOKEN_HELPER = [
  '-c',
  'credential.https://github.com.helper=',
  '-c',
  'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$HARPIA_GITHUB_TOKEN"; }; f'
]

function run(args: string[], cwd?: string): Promise<string> {
  const auth = process.env.HARPIA_GITHUB_TOKEN ? TOKEN_HELPER : []
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...auth, ...args],
      {
        cwd,
        // Nunca abre prompt de senha: sem credencial configurada na VPS, falha logo.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file' },
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
  async branchExists(repoPath, branch) {
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
      return true
    } catch {
      return false
    }
  }
}
