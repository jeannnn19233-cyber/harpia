import { execFile } from 'node:child_process'

export interface GitRunner {
  clone(input: { repoUrl: string; destination: string; branch: string | null }): Promise<void>
  currentBranch(repoPath: string): Promise<string>
}

function run(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
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
  async clone({ repoUrl, destination, branch }) {
    const args = ['clone']
    if (branch) args.push('--branch', branch)
    args.push('--', repoUrl, destination)
    await run(args)
  },
  currentBranch(repoPath) {
    return run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  }
}
