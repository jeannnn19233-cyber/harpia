// Servidor para testes de interface: agentes de mentira, sem internet nem tmux.
// Uso: node --disable-warning=ExperimentalWarning server/test/e2e-server.ts <pasta-de-dados>
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildApp } from '../src/app.ts'
import type { ProviderFactory } from '../src/chat/providers/types.ts'
import { FakeAgentSystem } from './fake-agents.ts'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const scripted: ProviderFactory = (input) => {
  let turn = 0
  return {
    async send(text) {
      turn++
      const id = turn
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
        } else {
          input.hooks.onToolEnd(`b${id}`, false, null)
          input.hooks.onTurnEnd('A pessoa recusou o comando.')
        }
      })()
    },
    async interrupt() {
      input.hooks.onTurnEnd('Interrompido.')
    },
    async setPermissionMode() {},
    close() {}
  }
}

const dataDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'harpia-e2e-')))
const { app } = await buildApp({
  config: {
    dataDir,
    reposDir: join(dataDir, 'repos'),
    cookieSecure: false,
    webDir: resolve(import.meta.dirname, '../../web/dist'),
    allowedOrigins: [],
    setupCode: null,
    terminalsEnabled: true,
    maxSessionsPerUser: 5
  },
  agents: new FakeAgentSystem(),
  chatProviders: scripted,
  git: { clone: async () => {}, fetch: async () => {}, defaultBranch: async () => 'main', branchExists: async () => true }
})
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 7421) })
console.log('pronto')
