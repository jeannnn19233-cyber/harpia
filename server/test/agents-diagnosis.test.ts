import { afterEach, describe, expect, it } from 'vitest'
import { claudeEffort, modelVersionName } from '../src/chat/providers/claude.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { fakeProviders } from './fake-chat.ts'
import { setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer

afterEach(async () => {
  await server?.close()
})

async function start(options: { terminalsEnabled?: boolean; models?: () => Promise<{ id: string; label: string; description: string; efforts?: string[] }[]> } = {}) {
  const agents = new FakeAgentSystem()
  const providers = fakeProviders()
  server = await startServer({
    agents,
    terminalsEnabled: options.terminalsEnabled ?? true,
    chatProviders: providers.factory,
    chatModels: async () => (options.models ? options.models() : [{ id: 'opus', label: 'Opus 5.5', description: '', efforts: ['low', 'high'] }])
  })
  const admin = await setupAdmin(server.app)
  return { agents, providers, admin }
}

const diagnose = (cookie: string, provider: 'claude' | 'codex', live = false) =>
  server.app.inject({ method: 'POST', url: '/api/me/agents/diagnose', headers: { cookie }, payload: { provider, live } })

describe('diagnóstico dos agentes', () => {
  it('para na primeira etapa que falha: servidor desligado', async () => {
    const { admin } = await start({ terminalsEnabled: false })
    const steps = (await diagnose(admin.cookie, 'claude')).json().steps
    expect(steps).toEqual([{ key: 'server', ok: false, detail: expect.stringContaining('HARPIA_TERMINALS=on') }])
  })

  it('aponta login que falta, depois programa e a resposta de verdade', async () => {
    const { agents, providers, admin } = await start()
    let steps = (await diagnose(admin.cookie, 'codex')).json().steps
    expect(steps.map((step: { key: string; ok: boolean }) => [step.key, step.ok])).toEqual([
      ['server', true],
      ['user', true],
      ['login', false]
    ])
    expect(steps[2].detail).toContain('Conectar Codex')

    agents.accountsByUser.set(admin.userId, { claude: true, codex: true })
    steps = (await diagnose(admin.cookie, 'claude')).json().steps
    expect(steps.at(-1)).toEqual({ key: 'program', ok: true, detail: expect.stringContaining('1 modelo(s): Opus 5.5') })

    // Teste completo: o agente recebe "responda ok" com o modelo mais barato e sem ferramentas.
    const pending = diagnose(admin.cookie, 'claude', true)
    for (let i = 0; i < 200 && providers.created.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    const provider = providers.last()
    for (let i = 0; i < 200 && provider.sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(provider.input).toMatchObject({ model: 'haiku', bare: true, policy: { tools: [] } })
    provider.hooks.onTextDone('t', 'ok')
    provider.hooks.onTurnEnd(null)
    steps = (await pending).json().steps
    expect(steps.at(-1)).toEqual({ key: 'reply', ok: true, detail: 'O Claude Code respondeu: "ok"' })
  })

  it('mostra o erro do programa e o da resposta', async () => {
    const { agents, providers, admin } = await start({ models: async () => Promise.reject(new Error('spawn /usr/local/bin/claude ENOENT')) })
    agents.accountsByUser.set(admin.userId, { claude: true, codex: true })
    let steps = (await diagnose(admin.cookie, 'claude')).json().steps
    expect(steps.at(-1)).toEqual({ key: 'program', ok: false, detail: 'O Claude Code não abriu direito: spawn /usr/local/bin/claude ENOENT' })

    await server.close()
    const again = await start()
    again.agents.accountsByUser.set(again.admin.userId, { claude: true, codex: true })
    const pending = diagnose(again.admin.cookie, 'codex', true)
    for (let i = 0; i < 200 && again.providers.created.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    const provider = again.providers.last()
    for (let i = 0; i < 200 && provider.sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    provider.hooks.onTurnEnd('Your access token could not be refreshed. Please log in again.')
    steps = (await pending).json().steps
    expect(steps.at(-1)).toEqual({ key: 'reply', ok: false, detail: 'Your access token could not be refreshed. Please log in again.' })
    void providers
  })
})

describe('modelo e esforço', () => {
  it('a lista diz qual versão do modelo o atalho usa', () => {
    expect(modelVersionName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelVersionName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelVersionName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelVersionName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelVersionName('opus')).toBeNull()
    expect(claudeEffort('xhigh')).toBe('xhigh')
    expect(claudeEffort('minimal')).toBeUndefined()
    expect(claudeEffort(null)).toBeUndefined()
  })

  it('a conversa guarda o esforço e avisa o agente aberto', async () => {
    const { providers, admin } = await start()
    const created = await server.app.inject({ method: 'POST', url: '/api/chats', headers: { cookie: admin.cookie }, payload: { provider: 'claude' } })
    const chat = created.json().chat
    expect(chat.effort).toBeNull()
    await server.app.inject({ method: 'POST', url: `/api/chats/${chat.id}/messages`, headers: { cookie: admin.cookie }, payload: { text: 'oi' } })
    const provider = providers.last()

    const changed = await server.app.inject({ method: 'PATCH', url: `/api/chats/${chat.id}`, headers: { cookie: admin.cookie }, payload: { effort: 'high' } })
    expect(changed.json().chat.effort).toBe('high')
    expect(provider.effort).toBe('high')
    const bad = await server.app.inject({ method: 'PATCH', url: `/api/chats/${chat.id}`, headers: { cookie: admin.cookie }, payload: { effort: 'turbo' } })
    expect(bad.statusCode).toBe(400)
  })
})
