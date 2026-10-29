import { execFile, spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, chown, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node-pty'
import type { AgentAccounts, ChangedFile, Project, Task, User } from '../../../shared/types.ts'
import type { AgentSystem, TerminalHandle } from './system.ts'
import { UserGit } from './user-git.ts'

// Cada pessoa do Harpia vira um usuário Linux "h<id>" com uid fixo. Assim a pasta pessoal,
// guardada no volume, continua dela mesmo quando o container é recriado.
const UID_BASE = 20000
const TMUX_SOCKET = 'harpia'
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const REQUIRED_COMMANDS = ['tmux', 'runuser', 'useradd', 'git', 'bash']

const TMUX_CONF = `# Gerado pelo Harpia.
set -g history-limit 50000
set -g status off
set -g mouse on
set -g escape-time 10
set -g default-terminal "screen-256color"
set -g window-size latest
`

function exec(command: string, args: string[], cwd = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout.trim())
    })
  })
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await exec('bash', ['-c', 'command -v "$0"', command])
    return true
  } catch {
    return false
  }
}

export class LinuxAgentSystem implements AgentSystem {
  private readonly homesDir: string
  private readonly tmuxConf: string
  private readonly reason: string | null

  private constructor(homesDir: string, tmuxConf: string, reason: string | null) {
    this.homesDir = homesDir
    this.tmuxConf = tmuxConf
    this.reason = reason
  }

  static async create(options: { homesDir: string; runDir: string }): Promise<LinuxAgentSystem> {
    const tmuxConf = join(options.runDir, 'tmux.conf')
    let reason: string | null = null
    if (process.platform !== 'linux') {
      reason = 'Terminais só funcionam com o servidor do Harpia em Linux.'
    } else if (process.getuid?.() !== 0) {
      reason = 'O servidor do Harpia precisa rodar como root dentro do container para criar um usuário por pessoa.'
    } else {
      for (const command of REQUIRED_COMMANDS) {
        if (!(await commandExists(command))) {
          reason = `Falta o programa "${command}" no servidor.`
          break
        }
      }
    }
    if (!reason) {
      await mkdir(options.homesDir, { recursive: true })
      await chmod(options.homesDir, 0o755)
      await mkdir(options.runDir, { recursive: true })
      await chmod(options.runDir, 0o755)
      await writeFile(tmuxConf, TMUX_CONF, { mode: 0o644 })
    }
    return new LinuxAgentSystem(options.homesDir, tmuxConf, reason)
  }

  unavailableReason(): string | null {
    return this.reason
  }

  private linuxName(user: User): string {
    return `h${user.id}`
  }

  homeDir(user: User): string {
    return join(this.homesDir, this.linuxName(user))
  }

  // Ambiente limpo: nada do servidor (tokens, código de configuração) chega aos agentes.
  private env(user: User): string[] {
    const name = this.linuxName(user)
    return [
      `HOME=${this.homeDir(user)}`,
      `USER=${name}`,
      `LOGNAME=${name}`,
      'SHELL=/bin/bash',
      `PATH=${PATH}`,
      'LANG=C.UTF-8',
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      // As versões dos agentes vêm da imagem; atualizar é trocar a versão no Dockerfile.
      'DISABLE_AUTOUPDATER=1'
    ]
  }

  private asUser(user: User, args: string[]): Promise<string> {
    return exec('runuser', ['-u', this.linuxName(user), '--', 'env', '-i', ...this.env(user), ...args])
  }

  async prepareUser(user: User): Promise<void> {
    const name = this.linuxName(user)
    const home = this.homeDir(user)
    try {
      await exec('getent', ['passwd', name])
    } catch {
      await exec('useradd', [
        '--uid',
        String(UID_BASE + user.id),
        '--user-group',
        '--no-create-home',
        '--home-dir',
        home,
        '--shell',
        '/bin/bash',
        name
      ])
    }
    const uid = Number(await exec('id', ['-u', name]))
    const gid = Number(await exec('id', ['-g', name]))
    await mkdir(home, { recursive: true })
    await chown(home, uid, gid)
    await chmod(home, 0o700)
    await this.asUser(user, ['git', 'config', '--global', 'user.name', user.name])
    await this.asUser(user, ['git', 'config', '--global', 'user.email', user.email])
  }

  async prepareFolder(user: User, relativePath: string): Promise<string> {
    if (relativePath.split('/').some((part) => part === '..' || part === '')) throw new Error('Caminho inválido.')
    await this.prepareUser(user)
    const path = join(this.homeDir(user), relativePath)
    await this.asUser(user, ['mkdir', '-p', path])
    return path
  }

  // O espelho pertence ao servidor; o git só deixa outro usuário clonar se ele estiver marcado como seguro.
  private async markSafe(repoPath: string): Promise<void> {
    let current: string[] = []
    try {
      current = (await exec('git', ['config', '--system', '--get-all', 'safe.directory'])).split('\n')
    } catch {
      current = []
    }
    if (!current.includes(repoPath)) await exec('git', ['config', '--system', '--add', 'safe.directory', repoPath])
  }

  private userGit(user: User): UserGit {
    return new UserGit((args) => this.asUser(user, args), this.homeDir(user))
  }

  async prepareWorktree(input: { user: User; project: Project; task: Task; mirrorPath: string }) {
    await this.markSafe(input.mirrorPath)
    return this.userGit(input.user).prepareWorktree(input)
  }

  async startSession(input: { user: User; name: string; cwd: string; command: string | null }): Promise<void> {
    const command = input.command ? ['bash', '-lc', input.command] : ['bash', '-l']
    await this.asUser(input.user, [
      'tmux',
      '-L',
      TMUX_SOCKET,
      '-f',
      this.tmuxConf,
      'new-session',
      '-d',
      '-s',
      input.name,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      input.cwd,
      ...command
    ])
  }

  async isRunning(user: User, name: string): Promise<boolean> {
    try {
      await this.asUser(user, ['tmux', '-L', TMUX_SOCKET, 'has-session', '-t', `=${name}`])
      return true
    } catch {
      return false
    }
  }

  async stopSession(user: User, name: string): Promise<void> {
    try {
      await this.asUser(user, ['tmux', '-L', TMUX_SOCKET, 'kill-session', '-t', `=${name}`])
    } catch {
      // Já tinha terminado.
    }
  }

  attach(input: { user: User; name: string; readOnly: boolean; cols: number; rows: number }): TerminalHandle {
    // Quem só assiste entra em modo leitura e não muda o tamanho da tela de quem está digitando.
    const flags = input.readOnly ? ['-f', 'read-only,ignore-size'] : []
    const terminal = spawn(
      'runuser',
      [
        '-u',
        this.linuxName(input.user),
        '--',
        'env',
        '-i',
        ...this.env(input.user),
        'tmux',
        '-L',
        TMUX_SOCKET,
        'attach-session',
        '-t',
        `=${input.name}`,
        ...flags
      ],
      { name: 'xterm-256color', cols: input.cols, rows: input.rows, cwd: '/', env: { PATH } }
    )
    return {
      onData: (listener) => void terminal.onData(listener),
      onExit: (listener) => void terminal.onExit(() => listener()),
      write: (data) => terminal.write(data),
      resize: (cols, rows) => terminal.resize(cols, rows),
      kill: () => terminal.kill()
    }
  }

  spawnPiped(input: { user: User; command: string; args: string[]; cwd: string; env?: Record<string, string> }): ChildProcess {
    const extra = Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${value}`)
    return spawnChild(
      'runuser',
      ['-u', this.linuxName(input.user), '--', 'env', '-i', '-C', input.cwd, ...this.env(input.user), ...extra, input.command, ...input.args],
      { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: { PATH } }
    )
  }

  changedFiles(input: { user: User; path: string; base: string }): Promise<ChangedFile[]> {
    return this.userGit(input.user).changedFiles(input.path, input.base)
  }

  hasUncommittedChanges(input: { user: User; path: string }): Promise<boolean> {
    return this.userGit(input.user).hasUncommittedChanges(input.path)
  }

  commitAll(input: { user: User; path: string; message: string }): Promise<void> {
    return this.userGit(input.user).commitAll(input.path, input.message)
  }

  commitsAhead(input: { user: User; path: string; base: string }): Promise<number> {
    return this.userGit(input.user).commitsAhead(input.path, input.base)
  }

  exportBranch(input: { user: User; path: string; branch: string }): Promise<string> {
    return this.userGit(input.user).exportBranch(input.path, input.branch)
  }

  async accounts(user: User): Promise<AgentAccounts> {
    const home = this.homeDir(user)
    return {
      claude: existsSync(join(home, '.claude', '.credentials.json')),
      codex: existsSync(join(home, '.codex', 'auth.json'))
    }
  }
}
