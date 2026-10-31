import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loginError, parseLoginOutput } from '../src/agents/login.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

// Saídas copiadas dos programas de verdade (Claude Code 2.1, Codex 0.165), com cores e links.
const CLAUDE_OUTPUT =
  'Opening browser to sign in…\r\nIf the browser didn\'t open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\x07\x1b[94mhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > '
const CODEX_OUTPUT =
  'Welcome to Codex [v\x1b[90m0.165.0\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mR32W-C5MXX\x1b[0m\n'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  input = ''
  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => (this.input += chunk.toString()))
  }
  exit(code: number) {
    this.exitCode = code
    this.emit('exit', code)
  }
  kill() {
    if (this.exitCode === null) this.exit(143)
    return true
  }
}

let server: TestServer

afterEach(async () => {
  await server?.close()
})

async function start() {
  const agents = new FakeAgentSystem()
  const children: { command: string; args: string[]; userId: number; child: FakeChild }[] = []
  agents.piped = ({ user, command, args }) => {
    const child = new FakeChild()
    children.push({ command, args, userId: user.id, child })
    return child as unknown as ChildProcess
  }
  server = await startServer({ agents, terminalsEnabled: true })
  const admin = await setupAdmin(server.app)
  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, cookie = admin.cookie) =>
    server.app.inject({ method, url, headers: { cookie }, payload })
  return { agents, children, admin, api }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('conectar os agentes sem terminal', () => {
  it('Claude: mostra o link, recebe o código colado e conecta', async () => {
    const { agents, children, admin, api } = await start()
    const starting = api('POST', '/api/me/agents/login/claude')
    while (children.length === 0) await tick()
    const { command, args, child, userId } = children[0]
    expect([command, ...args]).toEqual(['claude', 'auth', 'login', '--claudeai'])
    expect(userId).toBe(admin.userId)
    child.stdout.write(CLAUDE_OUTPUT)
    const login = (await starting).json().login
    expect(login).toEqual({
      provider: 'claude',
      stage: 'open_link',
      url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz',
      deviceCode: null,
      needsCode: true,
      error: null
    })

    expect((await api('POST', '/api/me/agents/login/claude/code', { code: 'curto' })).statusCode).toBe(400)
    const submitting = api('POST', '/api/me/agents/login/claude/code', { code: '  abcdefghij#state123  ' })
    while (!child.input) await tick()
    expect(child.input).toBe('abcdefghij#state123\n')
    agents.accountsByUser.set(admin.userId, { claude: true, codex: false })
    child.stdout.write('Login successful.\n')
    child.exit(0)
    expect((await submitting).json().login).toMatchObject({ stage: 'done', error: null })
    expect((await api('GET', '/api/me/agents/login')).json()).toMatchObject({
      accounts: { claude: true, codex: false },
      logins: { claude: { stage: 'done' }, codex: null }
    })
  })

  it('Claude: código recusado vira uma mensagem que diz o que fazer', async () => {
    const { children, api } = await start()
    const starting = api('POST', '/api/me/agents/login/claude')
    while (children.length === 0) await tick()
    const { child } = children[0]
    child.stdout.write(CLAUDE_OUTPUT)
    await starting
    const submitting = api('POST', '/api/me/agents/login/claude/code', { code: 'codigo-velho-123' })
    while (!child.input) await tick()
    child.stderr.write("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt.\n")
    child.exit(1)
    const login = (await submitting).json().login
    expect(login.stage).toBe('failed')
    expect(login.error).toContain('O Claude não aceitou o código')
    // O login acabou: colar de novo pede para recomeçar.
    expect((await api('POST', '/api/me/agents/login/claude/code', { code: 'codigo-novo-1234' })).statusCode).toBe(409)
  })

  it('Codex: mostra o link e o código, e conecta quando a pessoa autoriza', async () => {
    const { agents, children, admin, api } = await start()
    const starting = api('POST', '/api/me/agents/login/codex')
    while (children.length === 0) await tick()
    const { command, args, child } = children[0]
    expect([command, ...args]).toEqual(['codex', 'login', '--device-auth'])
    // O link chega antes do código: só responde quando os dois apareceram.
    child.stdout.write(CODEX_OUTPUT.slice(0, CODEX_OUTPUT.indexOf('2. Enter')))
    await tick()
    child.stdout.write(CODEX_OUTPUT.slice(CODEX_OUTPUT.indexOf('2. Enter')))
    expect((await starting).json().login).toMatchObject({
      stage: 'open_link',
      url: 'https://auth.openai.com/codex/device',
      deviceCode: 'R32W-C5MXX',
      needsCode: false
    })
    agents.accountsByUser.set(admin.userId, { claude: false, codex: true })
    child.stdout.write('Successfully logged in\n')
    child.exit(0)
    await tick()
    expect((await api('GET', '/api/me/agents/login')).json().logins.codex).toMatchObject({ stage: 'done' })
  })

  it('cada pessoa vê só o próprio login; recomeçar encerra o anterior; desconectar roda o logout', async () => {
    const { children, admin, api } = await start()
    const bruno = await addMember(server.app, admin.cookie, 'Bruno Lima', 'bruno@exemplo.com')
    const first = api('POST', '/api/me/agents/login/codex')
    while (children.length === 0) await tick()
    children[0].child.stdout.write(CODEX_OUTPUT)
    await first
    expect((await api('GET', '/api/me/agents/login', undefined, bruno.cookie)).json().logins.codex).toBeNull()

    const second = api('POST', '/api/me/agents/login/codex')
    while (children.length === 1) await tick()
    expect(children[0].child.exitCode).toBe(143)
    children[1].child.stdout.write(CODEX_OUTPUT)
    await second
    expect((await api('GET', '/api/me/agents/login')).json().logins.codex).toMatchObject({ stage: 'open_link' })

    await api('DELETE', '/api/me/agents/login/codex')
    expect(children[1].child.exitCode).toBe(143)
    expect((await api('GET', '/api/me/agents/login')).json().logins.codex).toBeNull()

    const out = api('POST', '/api/me/agents/logout/claude')
    while (children.length === 2) await tick()
    expect([children[2].command, ...children[2].args]).toEqual(['claude', 'auth', 'logout'])
    children[2].child.exit(0)
    expect((await out).statusCode).toBe(200)
    expect((await api('POST', '/api/me/agents/login/gemini')).statusCode).toBe(404)
  })

  it('programa que termina sem mostrar o link explica o motivo', async () => {
    const { children, api } = await start()
    const starting = api('POST', '/api/me/agents/login/codex')
    while (children.length === 0) await tick()
    children[0].child.stderr.write('WARNING: proceeding, even though we could not create PATH aliases\nError: failed to request device code: 403 Forbidden\n')
    children[0].child.exit(1)
    const login = (await starting).json().login
    expect(login.stage).toBe('failed')
    expect(login.error).toBe('O Codex recusou o login: Error: failed to request device code: 403 Forbidden')
  })

  it('servidor sem agentes recusa com o motivo', async () => {
    const { agents, api } = await start()
    agents.reason = 'Terminais só funcionam com o servidor do Harpia em Linux.'
    const response = await api('POST', '/api/me/agents/login/claude')
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toContain('Linux')
  })
})

describe('leitura da saída do login', () => {
  it('acha link e código mesmo com cores e links clicáveis', () => {
    expect(parseLoginOutput('claude', CLAUDE_OUTPUT).url).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
    expect(parseLoginOutput('codex', CODEX_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', deviceCode: 'R32W-C5MXX' })
    expect(parseLoginOutput('codex', CODEX_OUTPUT.slice(0, 300)).deviceCode).toBeNull()
    expect(loginError('codex', 'Error: device code expired')).toBe('O código do Codex venceu. Clique em "Conectar" de novo.')
    expect(loginError('claude', '')).toBe('O login do Claude Code terminou sem dar certo.')
    expect(loginError('claude', `${CLAUDE_OUTPUT}\nSomething broke\n`)).toBe('O Claude Code recusou o login: Something broke')
  })
})
