import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ClaudeMessageMapper, describeClaudeTool } from '../src/chat/providers/claude.ts'
import { createCodexProvider, listCodexModels } from '../src/chat/providers/codex.ts'
import type { ProviderHooks } from '../src/chat/providers/types.ts'

// Grava tudo o que o provedor avisa, na ordem.
function recorder(decision: 'allow' | 'deny' = 'allow') {
  const log: unknown[][] = []
  let resolveTurn: (error: string | null) => void = () => undefined
  const turnEnded = new Promise<string | null>((resolve) => (resolveTurn = resolve))
  const hooks: ProviderHooks = {
    onSession: (id) => log.push(['session', id]),
    onTextDelta: (key, delta) => log.push(['delta', key, delta]),
    onTextDone: (key, text) => log.push(['done', key, text]),
    onToolStart: (key, name, summary) => log.push(['tool', key, name, summary]),
    onToolEnd: (key, ok, output) => log.push(['toolEnd', key, ok, output]),
    requestApproval: async ({ title, detail }) => {
      log.push(['approval', title, detail])
      return decision
    },
    onNotice: (text) => log.push(['notice', text]),
    onSuggestion: (text) => log.push(['suggestion', text]),
    onTurnEnd: (error) => {
      log.push(['turnEnd', error])
      resolveTurn(error)
    },
    onExit: (error) => log.push(['exit', error])
  }
  return { log, hooks, turnEnded }
}

const fakeServer = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))
const user = { id: 1, name: 'Ana', email: 'ana@x.com', role: 'admin' as const, githubLogin: null, codexSuggestions: true, createdAt: '' }

function codexWith(decision: 'allow' | 'deny', resumeId: string | null = null, model: string | null = null) {
  const record = recorder(decision)
  const provider = createCodexProvider(
    { provider: 'codex', user, cwd: '/trabalho/T-1', resumeId, permissionMode: 'ask', model, policy: null, instructions: 'Task T-1', hooks: record.hooks },
    ({ cwd }) =>
      spawn(process.execPath, [fakeServer], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, EXPECTED_CWD: cwd } })
  )
  return { ...record, provider }
}

describe('adaptador do Codex', () => {
  it('abre a conversa, transmite a resposta e pede aprovação para comandos', async () => {
    const { provider, log, turnEnded } = codexWith('allow')
    await provider.send('testes')
    expect(await turnEnded).toBeNull()
    provider.close()
    expect(log).toEqual([
      ['session', 'thread-novo'],
      ['notice', 'A conexão com a OpenAI caiu. Tentando de novo (2 de 5)…'],
      ['delta', 'msg-1', 'Rodando '],
      ['delta', 'msg-1', '"testes"'],
      ['approval', 'Executar comando', 'npm test\nrodar testes'],
      ['tool', 'cmd-1', 'Comando', 'npm test'],
      ['toolEnd', 'cmd-1', true, 'ok 3 testes'],
      ['done', 'msg-1', 'Rodando "testes". Pronto.'],
      ['turnEnd', null]
    ])
  })

  it('recusar a aprovação faz a vez terminar com o erro do Codex', async () => {
    const { provider, turnEnded } = codexWith('deny')
    await provider.send('testes')
    expect(await turnEnded).toBe('Comando recusado')
    provider.close()
  })

  it('mensagem enviada durante a vez entra no meio do trabalho (turn/steer)', async () => {
    const { provider, log, turnEnded } = codexWith('allow')
    await provider.send('testes')
    await provider.steer('enquanto isso, siga para a parte 4')
    await turnEnded
    provider.close()
    expect(log).toContainEqual(['delta', 'steer-1', 'Também vou: enquanto isso, siga para a parte 4'])
  })

  it('usa o modelo escolhido e troca no meio da conversa', async () => {
    const first = codexWith('allow', null, 'gpt-codex')
    await first.provider.send('oi')
    await first.turnEnded
    expect(first.log).toContainEqual(['delta', 'modelo', 'modelo gpt-codex'])
    await first.provider.setModel('gpt-mini')
    first.log.length = 0
    await first.provider.send('de novo')
    await new Promise((resolve) => setTimeout(resolve, 100))
    first.provider.close()
    expect(first.log).toContainEqual(['delta', 'modelo', 'modelo gpt-mini'])
  })

  it('lista os modelos da conta da pessoa (model/list)', async () => {
    const models = await listCodexModels(() => spawn(process.execPath, [fakeServer], { stdio: ['pipe', 'pipe', 'pipe'] }), '/home')
    expect(models).toEqual([
      { id: 'gpt-codex', label: 'GPT Codex', description: 'Para programar' },
      { id: 'gpt-mini', label: 'gpt-mini', description: 'Rápido' }
    ])
  })

  it('retoma uma conversa existente', async () => {
    const { provider, log, turnEnded } = codexWith('allow', 'thread-antigo')
    await provider.send('oi')
    await turnEnded
    provider.close()
    expect(log[0]).toEqual(['session', 'thread-antigo'])
  })
})

describe('tradução das mensagens do Claude', () => {
  it('junta os pedaços de texto, as ferramentas e o fim da vez', () => {
    const { hooks, log } = recorder()
    const mapper = new ClaudeMessageMapper(hooks)
    const handle = (message: unknown) => mapper.handle(message as Parameters<typeof mapper.handle>[0])

    handle({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    handle({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
    handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Olá' } } })
    handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Olá, Ana.' }] } })
    handle({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } })
    handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } })
    handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'README.md', is_error: false }] } })
    handle({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })

    expect(log).toEqual([
      ['session', 'sess-1'],
      ['delta', 'm1:0', 'Olá'],
      ['done', 'm1:0', 'Olá, Ana.'],
      ['tool', 'tu1', 'Bash', ''],
      ['tool', 'tu1', 'Bash', 'ls'],
      ['toolEnd', 'tu1', true, 'README.md'],
      ['turnEnd', null]
    ])
  })

  it('troca a mensagem de falta de login por uma explicação e não repete o erro', () => {
    const { hooks, log } = recorder()
    const mapper = new ClaudeMessageMapper(hooks)
    const handle = (message: unknown) => mapper.handle(message as Parameters<typeof mapper.handle>[0])
    handle({ type: 'assistant', error: 'authentication_failed', message: { id: 'm1', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
    handle({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    expect(log).toEqual([['turnEnd', 'O Claude não está conectado na sua conta. Abra "Minhas IAs", conecte o Claude Code e envie a mensagem de novo.']])
  })

  it('repassa a sugestão de próxima mensagem do Claude', () => {
    const { hooks, log } = recorder()
    new ClaudeMessageMapper(hooks).handle({ type: 'prompt_suggestion', suggestion: '  rode os testes de novo ' } as never)
    expect(log).toEqual([['suggestion', 'rode os testes de novo']])
  })

  it('avisa quando o Claude está tentando reconectar', () => {
    const { hooks, log } = recorder()
    new ClaudeMessageMapper(hooks).handle({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10 } as never)
    expect(log).toEqual([['notice', 'A conexão com a Anthropic falhou. Tentando de novo (1 de 10)…']])
  })

  it('mostra o erro quando a vez termina com falha', () => {
    const { hooks, log } = recorder()
    const mapper = new ClaudeMessageMapper(hooks)
    mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Sem conexão'] } as never)
    expect(log).toEqual([['turnEnd', 'Sem conexão']])
  })

  it('resume as ferramentas mais comuns', () => {
    expect(describeClaudeTool('Edit', { file_path: 'src/app.ts' })).toBe('src/app.ts')
    expect(describeClaudeTool('Grep', { pattern: 'TODO' })).toBe('TODO')
  })
})
