// Servidor para testes de interface: agentes de mentira, sem internet nem tmux.
// Uso: node --disable-warning=ExperimentalWarning server/test/e2e-server.ts <pasta-de-dados>
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { buildApp } from '../src/app.ts'
import type { ProviderFactory } from '../src/chat/providers/types.ts'
import type { GitHubRepo } from '../src/github/client.ts'
import type { CoolifyClient } from '../src/monitors/coolify.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { FakeGitHub } from './fake-github.ts'
import { fakeGit } from './helpers.ts'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const scripted: ProviderFactory = (input) => {
  let turn = 0
  return {
    async send(text) {
      turn++
      const id = turn
      // Execução automática (rotina): responde sozinho, sem pedir aprovação.
      // Chamadas enxutas do vigia com IA (fase 4b).
      if (input.bare) {
        const instructions = input.instructions ?? ''
        const reply = instructions.includes('títulos parecidos')
          ? JSON.stringify({ same: true, reason: 'As duas fazem a mesma tela de pagamento por Pix.' })
          : instructions.includes('fechamento de uma task')
            ? JSON.stringify({
                summary: '**O que foi feito** Checkout com Pix usando QR dinâmico.\n\n**Decisões** QR dinâmico, por segurança.',
                learnings: [
                  { target: 'memory', text: 'Pagamentos novos sempre com QR dinâmico.', reason: 'A equipe decidiu isso nesta task.' },
                  { target: 'agents_md', text: 'Rode npm run check antes de abrir PR: o CI usa o mesmo comando.', reason: 'O PR quebrou no CI.' }
                ]
              })
            : 'Agora rode os testes de ponta a ponta'
        void (async () => {
          await sleep(300)
          input.hooks.onTextDone(`ai${id}`, reply)
          input.hooks.onTurnEnd(null)
        })()
        return
      }
      if (input.policy && input.instructions?.includes('revisor de PRs de')) {
        void (async () => {
          input.hooks.onToolStart(`rd${id}`, 'Read', 'src/pix.ts')
          await sleep(300)
          input.hooks.onToolEnd(`rd${id}`, true, 'export function total(valor) {…}')
          const sha = /topo=([0-9a-f]{7})/.exec(text)?.[1] ?? 'abc1234'
          const review = {
            revisoes: [
              {
                commit: 'inicial',
                evento: 'REQUEST_CHANGES',
                corpo: `Revisei \`${sha}\`. Pedi uma alteração: o \`valor\` pode ser negativo.\n\n**Bloqueios**\n- \`src/pix.ts:2\`: validar valor negativo.`,
                comentarios: [{ path: 'src/pix.ts', line: 2, body: 'Aqui o `valor` pode chegar negativo; vale recusar antes de calcular.' }]
              }
            ],
            achados: [{ arquivo: 'src/pix.ts', linha: 2, resumo: 'Valor negativo aceito no total do Pix', gravidade: 'bloqueia', status: 'aberto' }],
            licoes: [],
            pergunta: null,
            rascunho: 'travar',
            estado: 'revisado-bloqueia',
            resultado: `PR #42 revisada no ${sha}: 1 bloqueio`
          }
          input.hooks.onTextDone(`rv${id}`, '```json\n' + JSON.stringify(review) + '\n```')
          input.hooks.onTurnEnd(null)
        })()
        return
      }
      if (input.policy) {
        void (async () => {
          input.hooks.onSession(`sessao-${input.user.id}`)
          await sleep(300)
          input.hooks.onToolStart(`w${id}`, 'WebSearch', 'notícias de IA hoje')
          await sleep(300)
          input.hooks.onToolEnd(`w${id}`, true, '3 resultados')
          input.hooks.onTextDone(`r${id}`, '**Resumo da manhã**\n\n- Saiu o Node 26 ([link](https://nodejs.org))\n- Nova versão do Claude Code')
          input.hooks.onTurnEnd(null)
        })()
        return
      }
      void (async () => {
        input.hooks.onSession(`sessao-${input.user.id}`)
        const reply = `Entendi. Vou trabalhar em **${text}** na branch \`harpia\`.\n\nPrimeiro vou rodar os testes:`
        for (const piece of reply.match(/.{1,12}/gs) ?? []) {
          input.hooks.onTextDelta(`t${id}`, piece)
          await sleep(30)
        }
        input.hooks.onTextDone(`t${id}`, reply)
        input.hooks.onToolStart(`b${id}`, 'Bash', 'npm test')
        const decision = await input.hooks.requestApproval({ title: 'Usar Bash', detail: 'npm test' })
        if (decision === 'allow') {
          await sleep(200)
          input.hooks.onToolEnd(`b${id}`, true, '✓ 12 testes passaram')
          input.hooks.onTextDone(`f${id}`, 'Pronto. Os testes passaram:\n\n```\n✓ 12 testes\n```')
          input.hooks.onTurnEnd(null)
          input.hooks.onSuggestion('Agora siga para a parte 4')
        } else {
          input.hooks.onToolEnd(`b${id}`, false, null)
          input.hooks.onTurnEnd('A pessoa recusou o comando.')
        }
      })()
    },
    async steer(text) {
      input.hooks.onNotice(`Mensagem recebida durante o trabalho: "${text}"`)
    },
    async interrupt() {
      input.hooks.onTurnEnd('Interrompido.')
    },
    async setPermissionMode() {},
    async setModel() {},
    async setEffort() {},
    close() {}
  }
}

const dataDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'harpia-e2e-')))

// GitHub de mentira: o PR "tem merge" quando existe o arquivo merge-<número> na pasta de dados.
// Cada pessoa conecta o próprio token; aqui o token "ghp_e2e_<login>" vale pela conta <login>.
class E2EGitHub extends FakeGitHub {
  private nextPull = 41
  override async createPullRequest() {
    this.nextPull++
    return { number: this.nextPull, url: `https://github.com/clarumi/loja/pull/${this.nextPull}`, state: 'open' as const, merged: false }
  }
  override async findOpenPullRequest() {
    return null
  }
  override async getPullRequest(_repo: GitHubRepo, number: number) {
    const merged = existsSync(join(dataDir, `merge-${number}`))
    return { number, url: `https://github.com/clarumi/loja/pull/${number}`, state: merged ? ('closed' as const) : ('open' as const), merged }
  }
}
const github = new E2EGitHub()
// Um PR aberto por @carla-dev (de fora da equipe), para a revisão automática.
github.addPull({
  number: 42,
  title: 'Pagamento com Pix',
  url: 'https://github.com/clarumi/loja/pull/42',
  body: 'Adiciona o Pix.',
  authorLogin: 'carla-dev',
  headSha: 'abc1234def5678',
  headRef: 'pix'
})
github.files.set(42, [{ filename: 'src/pix.ts', patch: '@@ -1 +1,3 @@\n export const taxa = 0\n+export function total(valor) {\n+  return valor - taxa }' }])
const githubFor = (token: string) => {
  const login = /^ghp_e2e_([\w-]+)$/.exec(token)?.[1]
  if (!login) throw new Error('GitHub respondeu 401: Bad credentials')
  return github.as(login)
}

// Coolify de mentira para os vigias: um deploy concluído e uma tarefa agendada que falhou.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()
const coolify: CoolifyClient = {
  listApplications: async () => [{ uuid: 'loja-app', name: 'loja (produção)' }],
  getApplication: async () => ({ uuid: 'loja-app', name: 'loja (produção)', status: 'running:healthy', gitBranch: 'main' }),
  listDeployments: async () => [
    { id: 31, uuid: 'd31', status: 'finished', commit: 'abc1234def5678', commitMessage: 'Merge pull request #41', pullRequestId: 0, createdAt: minutesAgo(30), updatedAt: minutesAgo(27), logs: [] }
  ],
  listScheduledTasks: async () => [
    { uuid: 't1', name: 'expirar-propostas', enabled: true, frequency: '*/5 * * * *', createdAt: minutesAgo(600) },
    { uuid: 't2', name: 'anonimizar-leads', enabled: true, frequency: '0 7 * * *', createdAt: minutesAgo(6000) }
  ],
  listExecutions: async (_app, task) =>
    task === 't1'
      ? [{ status: 'failed', message: 'exit code 1: relation "propostas" does not exist', startedAt: minutesAgo(2), finishedAt: minutesAgo(2), createdAt: minutesAgo(2) }]
      : [{ status: 'success', message: null, startedAt: minutesAgo(60), finishedAt: minutesAgo(60), createdAt: new Date().toISOString() }]
}

// Alterações de mentira na cópia de cada pessoa.
const agents = new FakeAgentSystem()
agents.changes = [
  { path: 'src/checkout/Pix.tsx', status: '?', additions: null, deletions: null },
  { path: 'src/checkout/index.ts', status: 'M', additions: 42, deletions: 3 }
]
agents.uncommitted = true
// Login dos agentes: imita o Claude (pede o código colado) e o Codex (conecta sozinho depois de uns segundos).
agents.piped = ({ user, command }) => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null })
  const finish = (code: number) => {
    if (code === 0) agents.accountsByUser.set(user.id, { ...(agents.accountsByUser.get(user.id) ?? { claude: false, codex: false }), [command]: true })
    child.exitCode = code
    child.emit('exit', code)
  }
  Object.assign(child, { kill: () => child.exitCode === null && finish(143) })
  setTimeout(() => {
    if (command === 'claude') child.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=e2e\nPaste code here if prompted > ")
    else {
      child.stdout.write('1. Open this link\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   AB12-CD34E\n')
      setTimeout(() => finish(0), 3000)
    }
  }, 50)
  child.stdin.on('data', (chunk: Buffer) =>
    setTimeout(() => {
      const ok = String(chunk).trim().startsWith('certo')
      if (!ok) child.stderr.write("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt.\n")
      finish(ok ? 0 : 1)
    }, 300)
  )
  return child as unknown as ChildProcess
}
const { app } = await buildApp({
  config: {
    dataDir,
    reposDir: join(dataDir, 'repos'),
    cookieSecure: false,
    webDir: resolve(import.meta.dirname, '../../web/dist'),
    allowedOrigins: [],
    setupCode: null,
    terminalsEnabled: true,
    maxSessionsPerUser: 5,
    prPollSeconds: 60,
    watcherIntervalSeconds: 3600,
    routineTickSeconds: 5,
    maxConcurrentRuns: 3,
    reviewPollSeconds: 0,
    reviewSettleSeconds: 0,
    monitorPollSeconds: 0,
    vaultSyncSeconds: 0,
    aiInsights: true,
    staleHours: 48,
    reviewHours: 24
  },
  agents,
  github,
  githubFor,
  coolify,
  probe: async (url) => ({ status: 200, body: url.includes('ready') ? '{"status":"ok","banco":"ok"}' : 'ok' }),
  // Bot de mentira: aceita o vínculo e só guarda as mensagens.
  telegram: {
    getMe: async () => ({ username: 'harpia_teste_bot' }),
    getUpdates: async () => [],
    sendMessage: async () => {},
    sendTyping: async () => {},
    downloadFile: async () => Buffer.from('')
  },
  chatProviders: scripted,
  chatModels: async ({ provider }) =>
    provider === 'claude'
      ? [
          { id: 'opus', label: 'Opus 5.5', description: 'O mais capaz', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { id: 'sonnet', label: 'Sonnet 5.5', description: 'Equilibrado', efforts: ['low', 'medium', 'high'] }
        ]
      : [{ id: 'gpt-codex', label: 'GPT Codex', description: 'Para programar', efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' }],
  git: {
    ...fakeGit,
    fetchPull: async () => 'abc1234def5678',
    diff: async () =>
      ['diff --git a/src/pix.ts b/src/pix.ts', '--- a/src/pix.ts', '+++ b/src/pix.ts', '@@ -1 +1,3 @@', ' export const taxa = 0', '+export function total(valor) {', '+  return valor - taxa }'].join('\n')
  }
})
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 7421) })
console.log('pronto')
