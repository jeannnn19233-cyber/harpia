import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitHubClient } from '../src/github/client.ts'
import { appendLearning, parseSuggestion } from '../src/insights/prompts.ts'
import { systemGit, type GitRunner } from '../src/projects/git.ts'
import { fakeProviders, type FakeProvider } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { addMember, fakeGit, offlineGitHub, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let providers: ReturnType<typeof fakeProviders>
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let projectId: number
const commits: { branch: string; path: string; content: string; author: { name: string } }[] = []
const pushed: string[] = []
const pulls: { title: string; head: string; body: string }[] = []

const git: GitRunner = {
  ...fakeGit,
  async commitFile(_repo, input) {
    commits.push(input)
  },
  async push(_repo, _url, branch) {
    pushed.push(branch)
  }
}
const github: GitHubClient = {
  ...offlineGitHub,
  async createPullRequest(_repo, input) {
    pulls.push(input)
    return { number: 77, url: 'https://github.com/clarumi/loja/pull/77', state: 'open', merged: false }
  }
}

async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (method === 'GET' ? undefined : {}) })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

// Chamadas de IA do vigia (as "enxutas"), na ordem em que foram feitas.
const aiCalls = () => providers.created.filter((provider) => provider.input.bare)

async function answerAi(index: number, text: string): Promise<FakeProvider> {
  await waitFor(() => aiCalls().length > index && aiCalls()[index].sent.length > 0)
  const call = aiCalls()[index]
  call.hooks.onTextDone('r', text)
  call.hooks.onTurnEnd(null)
  await server.services.insights.idle()
  return call
}

async function newTask(title: string, cookie = ana.cookie, description = '') {
  return (await api('POST', `/api/projects/${projectId}/tasks`, cookie, { title, description })).json().task as {
    id: number
    number: number
  }
}

async function findings() {
  return (await api('POST', `/api/projects/${projectId}/findings/check`, ana.cookie)).json().findings as { kind: string; message: string }[]
}

beforeEach(async () => {
  commits.length = 0
  pushed.length = 0
  pulls.length = 0
  providers = fakeProviders()
  server = await startServer({ agents: new FakeAgentSystem(), git, github, terminalsEnabled: true, chatProviders: providers.factory, aiInsights: true })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  projectId = (await api('POST', '/api/projects', ana.cookie, { name: 'Loja', repoUrl: 'https://github.com/clarumi/loja.git' })).json().project.id
  for (let i = 0; i < 100; i++) {
    if ((await api('GET', `/api/projects/${projectId}`, ana.cookie)).json().project.cloneStatus === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
})

afterEach(async () => {
  await server.close()
})

describe('tasks parecidas com IA', () => {
  it('só avisa depois que o Claude de quem criou a task mais nova confirma', async () => {
    await newTask('Checkout com Pix')
    await newTask('Tela de checkout via Pix', bruno.cookie)
    expect(await findings()).toEqual([])

    const call = await answerAi(0, '{"same": true, "reason": "As duas criam a mesma tela de pagamento por Pix."}')
    expect(call.input.user.id).toBe(bruno.userId)
    expect(call.input.model).toBe('haiku')
    expect(call.input.policy).toEqual({ tools: [], roots: [call.input.cwd] })
    expect(call.sent[0]).toContain('T-1 "Checkout com Pix"')

    await server.services.watcher.sweep()
    const [finding] = await findings()
    expect(finding.kind).toBe('duplicate')
    expect(finding.message).toContain('As duas criam a mesma tela de pagamento por Pix. (confirmado pelo Claude de Bruno)')
    // Não pergunta de novo.
    await findings()
    expect(aiCalls()).toHaveLength(1)
  })

  it('tasks que a IA julga diferentes não viram aviso; se a IA falhar, vale a regra', async () => {
    await newTask('API de pagamentos com Pix')
    await newTask('Tela de pagamentos com Pix')
    await findings()
    await answerAi(0, '{"same": false, "reason": "Uma é o back-end e a outra a tela."}')
    expect(await findings()).toEqual([])

    await newTask('Relatório de vendas mensal')
    await newTask('Relatório de vendas por mês')
    await findings()
    await answerAi(1, 'não sei responder')
    const after = await findings()
    expect(after).toHaveLength(1)
    expect(after[0].message).toContain('Relatório de vendas mensal')
    expect(after[0].message).not.toContain('confirmado')
  })
})

describe('resumo e aprendizados', () => {
  async function doneTask() {
    const task = await newTask('Checkout com Pix', ana.cookie, 'Aceitar Pix no checkout.')
    await api('POST', `/api/tasks/${task.id}/comments`, bruno.cookie, { body: 'Decidimos usar o QR dinâmico.' })
    await api('PATCH', `/api/tasks/${task.id}`, ana.cookie, { status: 'done', ownerId: ana.userId })
    return task
  }

  const SUMMARY = JSON.stringify({
    summary: '**O que foi feito** Pix no checkout com QR dinâmico.',
    learnings: [
      { target: 'memory', text: 'Pagamentos novos sempre com QR dinâmico.', reason: 'A equipe decidiu isso na T-1.' },
      { target: 'agents_md', text: 'Rode npm run check antes de abrir PR: o CI usa o mesmo comando.', reason: 'O PR quebrou no CI.' }
    ]
  })

  it('o vigia resume a task concluída no Claude do responsável e guarda os aprendizados', async () => {
    const task = await doneTask()
    await server.services.watcher.sweep()
    const call = await answerAi(0, SUMMARY)
    expect(call.input.user.id).toBe(ana.userId)
    expect(call.input.model).toBe('sonnet')
    expect(call.input.instructions).toContain('NÃO transforme em aprendizado')
    expect(call.sent[0]).toContain('Task T-1 "Checkout com Pix" (Feito)')
    expect(call.sent[0]).toContain('Bruno comentou: Decidimos usar o QR dinâmico.')

    const insights = (await api('GET', `/api/tasks/${task.id}/insights`, bruno.cookie)).json()
    expect(insights.summary).toMatchObject({ status: 'ready', userId: ana.userId, summary: '**O que foi feito** Pix no checkout com QR dinâmico.' })
    expect(insights.learnings.map((learning: { target: string; status: string }) => [learning.target, learning.status])).toEqual([
      ['memory', 'pending'],
      ['agents_md', 'pending']
    ])
    const events = (await api('GET', `/api/tasks/${task.id}`, ana.cookie)).json().events
    expect(events.at(-1)).toMatchObject({ type: 'summarized', actorId: null, data: { userId: ana.userId, learnings: 2 } })
    expect((await api('GET', `/api/projects/${projectId}/learnings`, ana.cookie)).json().learnings).toHaveLength(2)

    // Não resume de novo sozinho.
    await server.services.watcher.sweep()
    expect(aiCalls()).toHaveLength(1)
  })

  it('aprovar leva o aprendizado para a memória ou para o AGENTS.md por PR; descartar registra', async () => {
    const task = await doneTask()
    await server.services.watcher.sweep()
    await answerAi(0, SUMMARY)
    const [memory, agents] = (await api('GET', `/api/tasks/${task.id}/insights`, ana.cookie)).json().learnings as { id: number }[]

    const applied = await api('POST', `/api/learnings/${memory.id}/apply`, bruno.cookie, { text: 'Pagamentos novos sempre com QR dinâmico do banco.' })
    expect(applied.json().learning).toMatchObject({ status: 'applied', decidedBy: bruno.userId })
    expect((await api('GET', `/api/projects/${projectId}/memory`, ana.cookie)).json().memory.body).toBe('- Pagamentos novos sempre com QR dinâmico do banco.')
    expect((await api('POST', `/api/learnings/${memory.id}/apply`, ana.cookie)).statusCode).toBe(409)

    const pr = await api('POST', `/api/learnings/${agents.id}/apply`, ana.cookie)
    expect(pr.json().learning).toMatchObject({ status: 'applied', prUrl: 'https://github.com/clarumi/loja/pull/77' })
    expect(commits).toEqual([
      expect.objectContaining({
        branch: `harpia/aprendizado-${agents.id}`,
        path: 'AGENTS.md',
        content: '# Instruções para agentes de IA\n\n## Aprendizados\n\n- Rode npm run check antes de abrir PR: o CI usa o mesmo comando.\n',
        author: expect.objectContaining({ name: 'Ana Admin' })
      })
    ])
    expect(pushed).toEqual([`harpia/aprendizado-${agents.id}`])
    expect(pulls[0].title).toBe('Aprendizado da T-1: Rode npm run check antes de abrir PR: o CI usa o mesmo co…')
    expect(pulls[0].body).toContain('**Por quê:** O PR quebrou no CI.')

    const events = (await api('GET', `/api/tasks/${task.id}`, ana.cookie)).json().events
    expect(events.filter((event: { type: string }) => event.type === 'learning_applied')).toHaveLength(2)
  })

  it('quem pede o resumo de novo usa o próprio Claude; descartar sai da lista', async () => {
    const task = await doneTask()
    const response = await api('POST', `/api/tasks/${task.id}/summary`, bruno.cookie)
    expect(response.json().summary).toMatchObject({ status: 'running', userId: bruno.userId })
    const call = await answerAi(0, SUMMARY)
    expect(call.input.user.id).toBe(bruno.userId)
    const [first] = (await api('GET', `/api/tasks/${task.id}/insights`, ana.cookie)).json().learnings as { id: number }[]
    expect((await api('POST', `/api/learnings/${first.id}/dismiss`, ana.cookie)).json().learning.status).toBe('dismissed')
    expect((await api('GET', `/api/projects/${projectId}/learnings`, ana.cookie)).json().learnings).toHaveLength(1)

    const open = await newTask('Outra')
    expect((await api('POST', `/api/tasks/${open.id}/summary`, ana.cookie)).statusCode).toBe(400)
  })

  it('falha da IA fica registrada, sem aprendizados', async () => {
    const task = await doneTask()
    await server.services.watcher.sweep()
    await waitFor(() => aiCalls().length === 1 && aiCalls()[0].sent.length > 0)
    aiCalls()[0].hooks.onTurnEnd('O Claude não está conectado na sua conta.')
    await server.services.insights.idle()
    const insights = (await api('GET', `/api/tasks/${task.id}/insights`, ana.cookie)).json()
    expect(insights.summary).toMatchObject({ status: 'failed', error: 'O Claude não está conectado na sua conta.' })
    expect(insights.learnings).toEqual([])
  })
})

describe('sugestão de próxima mensagem no Codex', () => {
  async function codexTurn(cookie = ana.cookie, provider = 'codex') {
    const task = await newTask('Checkout')
    const chat = (await api('POST', `/api/tasks/${task.id}/chats`, cookie, { provider })).json().chat
    await api('POST', `/api/chats/${chat.id}/messages`, cookie, { text: 'faça a parte 3' })
    const agent = providers.created.find((item) => !item.input.bare)!
    agent.hooks.onTextDone('a', 'Parte 3 pronta. Os testes passaram.')
    agent.hooks.onTurnEnd(null)
    return chat as { id: number }
  }

  it('o Claude (Haiku) da dona sugere a próxima mensagem depois de cada vez do Codex', async () => {
    const chat = await codexTurn()
    const call = await answerAi(0, '"Agora siga para a parte 4"')
    expect(call.input).toMatchObject({ model: 'haiku', bare: true })
    expect(call.input.user.id).toBe(ana.userId)
    expect(call.sent[0]).toContain('Pedido da pessoa:\nfaça a parte 3')
    expect((await api('GET', `/api/chats/${chat.id}`, ana.cookie)).json().chat.suggestion).toBe('Agora siga para a parte 4')
  })

  it('não sugere para o Claude (que já sugere sozinho) nem para quem desligou', async () => {
    await codexTurn(ana.cookie, 'claude')
    await api('PATCH', '/api/me', bruno.cookie, { codexSuggestions: false })
    await codexTurn(bruno.cookie)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(aiCalls()).toEqual([])
  })
})

describe('peças da fase 4b', () => {
  it('acrescenta o aprendizado na seção certa do AGENTS.md', () => {
    expect(appendLearning('# Regras\n\nUse pnpm.\n', 'Regra nova.')).toBe('# Regras\n\nUse pnpm.\n\n## Aprendizados\n\n- Regra nova.\n')
    const existing = '# Regras\n\n## Aprendizados\n\n- Antiga.\n\n## Deploy\n\nCoolify.\n'
    expect(appendLearning(existing, 'Nova\nem duas linhas.')).toBe(
      '# Regras\n\n## Aprendizados\n\n- Antiga.\n- Nova em duas linhas.\n\n## Deploy\n\nCoolify.\n'
    )
    expect(appendLearning('# Regras\n\n## Aprendizados\n', 'Primeira.')).toBe('# Regras\n\n## Aprendizados\n\n- Primeira.\n')
  })

  it('lê a sugestão e ignora quando não há próximo passo', () => {
    expect(parseSuggestion('"rode os testes"\n')).toBe('rode os testes')
    expect(parseSuggestion('[NENHUMA]')).toBeNull()
  })

  it('commitFile cria a branch com o arquivo no espelho, sem cópia de trabalho (git de verdade)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harpia-commit-'))
    try {
      const seed = join(root, 'seed')
      execFileSync('git', ['init', '-q', '-b', 'main', seed])
      writeFileSync(join(seed, 'AGENTS.md'), '# Regras\n')
      const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
      execFileSync('git', ['-C', seed, 'add', '.'], { env })
      execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'inicio'], { env })
      const mirror = join(root, 'mirror.git')
      execFileSync('git', ['clone', '-q', '--mirror', seed, mirror])

      expect(await systemGit.readFile(mirror, 'main', 'AGENTS.md')).toBe('# Regras')
      expect(await systemGit.readFile(mirror, 'main', 'NAO.md')).toBeNull()
      await systemGit.commitFile(mirror, {
        base: 'main',
        branch: 'harpia/aprendizado-1',
        path: 'AGENTS.md',
        content: appendLearning('# Regras\n', 'Use pnpm.'),
        message: 'Aprendizado',
        author: { name: 'Ana Souza', email: 'ana@x.com' }
      })
      const show = (args: string[]) => String(execFileSync('git', ['-C', mirror, ...args])).trim()
      expect(show(['show', 'harpia/aprendizado-1:AGENTS.md'])).toBe('# Regras\n\n## Aprendizados\n\n- Use pnpm.')
      expect(show(['log', '-1', '--format=%an <%ae> %s', 'harpia/aprendizado-1'])).toBe('Ana Souza <ana@x.com> Aprendizado')
      expect(show(['show', 'main:AGENTS.md'])).toBe('# Regras')
      expect(show(['rev-parse', 'harpia/aprendizado-1^'])).toBe(show(['rev-parse', 'main']))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
