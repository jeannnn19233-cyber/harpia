// Servidor para testes de interface: agentes de mentira, sem internet nem tmux.
// Uso: node --disable-warning=ExperimentalWarning server/test/e2e-server.ts <pasta-de-dados>
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildApp } from '../src/app.ts'
import type { ProviderFactory } from '../src/chat/providers/types.ts'
import type { GitHubClient } from '../src/github/client.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { fakeGit } from './helpers.ts'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const scripted: ProviderFactory = (input) => {
  let turn = 0
  return {
    async send(text) {
      turn++
      const id = turn
      // Execução automática (rotina): responde sozinho, sem pedir aprovação.
      if (input.policy && input.instructions?.includes('revisor de código')) {
        void (async () => {
          input.hooks.onToolStart(`rd${id}`, 'Read', 'src/pix.ts')
          await sleep(300)
          input.hooks.onToolEnd(`rd${id}`, true, 'export function total(valor) {…}')
          const review = {
            verdict: 'request_changes',
            summary: 'Adiciona o cálculo do Pix. Falta validar valor negativo.',
            findings: [{ path: 'src/pix.ts', line: 2, severity: 'warning', title: 'Valor negativo aceito', body: 'O `valor` pode ser negativo.' }]
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
    close() {}
  }
}

const dataDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'harpia-e2e-')))

// GitHub de mentira: o PR "tem merge" quando existe o arquivo merge-<número> na pasta de dados.
let nextPull = 41
const github: GitHubClient = {
  // Um PR aberto por @ana-dev, para a revisão automática.
  async listOpenPullRequests() {
    return [
      {
        number: 42,
        title: 'Pagamento com Pix',
        url: 'https://github.com/clarumi/loja/pull/42',
        body: 'Adiciona o Pix.',
        draft: false,
        authorLogin: 'ana-dev',
        headSha: 'abc1234def5678',
        baseRef: 'main',
        labels: []
      }
    ]
  },
  async createReview() {
    return { url: 'https://github.com/clarumi/loja/pull/1#pullrequestreview-1' }
  },
  async createPullRequest() {
    nextPull++
    return { number: nextPull, url: `https://github.com/clarumi/loja/pull/${nextPull}`, state: 'open', merged: false }
  },
  async findOpenPullRequest() {
    return null
  },
  async getPullRequest(_repo, number) {
    const merged = existsSync(join(dataDir, `merge-${number}`))
    return { number, url: `https://github.com/clarumi/loja/pull/${number}`, state: merged ? 'closed' : 'open', merged }
  }
}

// Alterações de mentira na cópia de cada pessoa.
const agents = new FakeAgentSystem()
agents.changes = [
  { path: 'src/checkout/Pix.tsx', status: '?', additions: null, deletions: null },
  { path: 'src/checkout/index.ts', status: 'M', additions: 42, deletions: 3 }
]
agents.uncommitted = true
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
    vaultSyncSeconds: 0,
    staleHours: 48,
    reviewHours: 24
  },
  agents,
  github,
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
          { id: 'opus', label: 'Opus', description: 'O mais capaz' },
          { id: 'sonnet', label: 'Sonnet', description: 'Equilibrado' }
        ]
      : [{ id: 'gpt-codex', label: 'GPT Codex', description: 'Para programar' }],
  git: {
    ...fakeGit,
    fetchPull: async () => 'abc1234def5678',
    diff: async () =>
      ['diff --git a/src/pix.ts b/src/pix.ts', '--- a/src/pix.ts', '+++ b/src/pix.ts', '@@ -1 +1,3 @@', ' export const taxa = 0', '+export function total(valor) {', '+  return valor - taxa }'].join('\n')
  }
})
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 7421) })
console.log('pronto')
