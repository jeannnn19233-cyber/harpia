import type { ChildProcess } from 'node:child_process'
import type { AgentLoginState, ChatProvider, User } from '../../../shared/types.ts'
import type { AgentSystem } from './system.ts'

// Conectar o Claude Code e o Codex sem terminal. O servidor roda o login do próprio programa
// como a pessoa (o mesmo que ela digitaria no terminal), lê o link que ele imprime e mostra na
// tela; no Claude, o código que a página devolve é colado num campo e vai para o programa.
// Antes, a pessoa abria um terminal, passava pelas telas iniciais do Claude e colava o código lá:
// muita gente travava no meio do caminho.

const LOGIN_COMMANDS: Record<ChatProvider, string[]> = {
  claude: ['claude', 'auth', 'login', '--claudeai'],
  codex: ['codex', 'login', '--device-auth']
}

const LOGOUT_COMMANDS: Record<ChatProvider, string[]> = {
  claude: ['claude', 'auth', 'logout'],
  codex: ['codex', 'logout']
}

const NAMES: Record<ChatProvider, string> = { claude: 'Claude Code', codex: 'Codex' }

// O código do Codex vale 15 minutos; o do Claude, menos. Depois disso o programa fica parado.
const FLOW_TIMEOUT_MS = 15 * 60 * 1000

// Cores, links clicáveis (OSC 8) e movimentos de cursor que os programas imprimem.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g

export function plainOutput(text: string): string {
  return text.replace(ANSI, '')
}

// O que interessa na saída do login: o link e, no Codex, o código de uso único.
export function parseLoginOutput(provider: ChatProvider, raw: string): { url: string | null; deviceCode: string | null } {
  const text = plainOutput(raw)
  if (provider === 'claude') {
    return { url: text.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0] ?? null, deviceCode: null }
  }
  return {
    url: text.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0] ?? null,
    deviceCode: text.match(/one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i)?.[1] ?? null
  }
}

// Mensagem de erro do programa, em português quando a gente conhece o caso.
export function loginError(provider: ChatProvider, output: string): string {
  const text = plainOutput(output).trim()
  if (/code wasn.t accepted|invalid.?grant|invalid code/i.test(text)) {
    return 'O Claude não aceitou o código. Ele pode ter sido copiado pela metade, ter vencido ou ser de uma tentativa anterior. Clique em "Conectar" de novo e use o código novo.'
  }
  if (/expired|timed out/i.test(text)) return `O código do ${NAMES[provider]} venceu. Clique em "Conectar" de novo.`
  if (/device code.*(disabled|not enabled)|enable device code/i.test(text)) {
    return 'A sua conta do ChatGPT não permite login por código. Ative "login por código de dispositivo" nas configurações de segurança do ChatGPT e tente de novo.'
  }
  const last = text
    .split('\n')
    .map((line) => line.trim())
    // O link e as instruções que o programa imprime não explicam o erro: só poluiriam a mensagem.
    .filter((line) => line && !/^WARNING: proceeding|https?:\/\/|^Paste code|^Opening browser|^Welcome to Codex|^\d\. /.test(line))
    .slice(-3)
    .join(' ')
  return last ? `O ${NAMES[provider]} recusou o login: ${last.slice(0, 400)}` : `O login do ${NAMES[provider]} terminou sem dar certo.`
}

interface Flow {
  userId: number
  state: AgentLoginState
  child: ChildProcess
  output: string
  timer: NodeJS.Timeout
  // Avisam quem está esperando a próxima mudança (o link aparecer, o programa terminar).
  waiters: (() => void)[]
}

export class AgentLogins {
  private readonly flows = new Map<string, Flow>()
  private readonly agents: AgentSystem

  constructor(agents: AgentSystem) {
    this.agents = agents
  }

  private key(user: User, provider: ChatProvider): string {
    return `${user.id}:${provider}`
  }

  state(user: User, provider: ChatProvider): AgentLoginState | null {
    return this.flows.get(this.key(user, provider))?.state ?? null
  }

  // Começa um login novo (cancela o anterior, se houver) e espera o link aparecer.
  async start(user: User, provider: ChatProvider): Promise<AgentLoginState> {
    this.cancel(user, provider)
    await this.agents.prepareUser(user)
    const [command, ...args] = LOGIN_COMMANDS[provider]
    const child = this.agents.spawnPiped({ user, command, args, cwd: this.agents.homeDir(user) })
    const flow: Flow = {
      userId: user.id,
      state: { provider, stage: 'open_link', url: null, deviceCode: null, needsCode: provider === 'claude', error: null },
      child,
      output: '',
      timer: setTimeout(() => this.fail(flow, `O login do ${NAMES[provider]} ficou parado por muito tempo. Clique em "Conectar" de novo.`), FLOW_TIMEOUT_MS),
      waiters: []
    }
    flow.timer.unref()
    this.flows.set(this.key(user, provider), flow)
    const onOutput = (chunk: Buffer) => {
      flow.output += chunk.toString()
      if (flow.state.url) return
      const found = parseLoginOutput(provider, flow.output)
      // No Codex, o link vem antes do código: espera os dois.
      if (found.url && (provider === 'claude' || found.deviceCode)) {
        flow.state = { ...flow.state, url: found.url, deviceCode: found.deviceCode }
        this.notify(flow)
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', (error) => this.fail(flow, `Não consegui abrir o ${NAMES[provider]} no servidor: ${error.message}`))
    child.on('exit', (code) => void this.finished(user, flow, code))
    await this.waitFor(flow, () => flow.state.url !== null || flow.state.stage !== 'open_link', 30000)
    if (flow.state.stage === 'open_link' && !flow.state.url) {
      this.fail(flow, `O ${NAMES[provider]} não mostrou o link de login em 30 s. ${loginError(provider, flow.output)}`)
    }
    return flow.state
  }

  // Claude: o código que a página mostra depois de autorizar.
  async submitCode(user: User, code: string): Promise<AgentLoginState | null> {
    const flow = this.flows.get(this.key(user, 'claude'))
    if (!flow || flow.state.stage !== 'open_link' || !flow.state.url) return null
    flow.state = { ...flow.state, stage: 'checking', error: null }
    flow.child.stdin?.write(`${code.trim()}\n`)
    await this.waitFor(flow, () => flow.state.stage !== 'checking', 60000)
    return flow.state
  }

  cancel(user: User, provider: ChatProvider): void {
    const flow = this.flows.get(this.key(user, provider))
    if (!flow) return
    this.flows.delete(this.key(user, provider))
    clearTimeout(flow.timer)
    if (flow.child.exitCode === null) flow.child.kill()
    this.notify(flow)
  }

  async logout(user: User, provider: ChatProvider): Promise<void> {
    this.cancel(user, provider)
    const [command, ...args] = LOGOUT_COMMANDS[provider]
    const child = this.agents.spawnPiped({ user, command, args, cwd: this.agents.homeDir(user) })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(loginError(provider, output)))))
    })
  }

  close(): void {
    for (const flow of this.flows.values()) {
      clearTimeout(flow.timer)
      if (flow.child.exitCode === null) flow.child.kill()
    }
    this.flows.clear()
  }

  private async finished(user: User, flow: Flow, code: number | null): Promise<void> {
    clearTimeout(flow.timer)
    if (flow.state.stage === 'failed' || this.flows.get(this.key(user, flow.state.provider)) !== flow) return
    if (code !== 0) return this.fail(flow, loginError(flow.state.provider, flow.output))
    // O programa disse que deu certo; confere se a credencial ficou mesmo na pasta da pessoa.
    const accounts = await this.agents.accounts(user)
    if (!accounts[flow.state.provider]) {
      return this.fail(flow, `O ${NAMES[flow.state.provider]} terminou o login, mas a credencial não apareceu na sua pasta do servidor.`)
    }
    flow.state = { ...flow.state, stage: 'done', error: null }
    this.notify(flow)
  }

  private fail(flow: Flow, error: string): void {
    clearTimeout(flow.timer)
    if (flow.state.stage === 'done') return
    flow.state = { ...flow.state, stage: 'failed', error }
    if (flow.child.exitCode === null) flow.child.kill()
    this.notify(flow)
  }

  private notify(flow: Flow): void {
    const waiters = flow.waiters
    flow.waiters = []
    for (const waiter of waiters) waiter()
  }

  private waitFor(flow: Flow, done: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref()
      const check = () => {
        if (done() || !this.flows.has(`${flow.userId}:${flow.state.provider}`)) {
          clearTimeout(timer)
          resolve()
        } else flow.waiters.push(check)
      }
      check()
    })
  }
}
