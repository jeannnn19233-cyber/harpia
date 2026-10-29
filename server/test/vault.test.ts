import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TelegramMessage } from '../src/notify/telegram.ts'
import { fakeProviders } from './fake-chat.ts'
import { FakeAgentSystem } from './fake-agents.ts'
import { FakeTelegram } from './fake-telegram.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let agents: FakeAgentSystem
let telegram: FakeTelegram
let providers: ReturnType<typeof fakeProviders>
let ana: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let nextMessage = 100

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload: payload ?? (method === 'GET' ? undefined : {}) })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Condição não aconteceu a tempo.')
}

// Ana manda algo para o bot (já vinculada ao chat 555).
async function send(message: Partial<TelegramMessage>) {
  telegram.queue.push({
    update_id: nextMessage,
    message: { message_id: nextMessage++, date: 1793952000, chat: { id: 555 }, ...message }
  })
  await server.ctx.notifier.pollOnce()
}

async function answer(text: string | null, error: string | null = null) {
  await waitFor(() => providers.created.some((item) => item.sent.length > 0))
  const provider = providers.last()
  if (text) provider.hooks.onTextDone(`t${provider.sent.length}`, text)
  provider.hooks.onTurnEnd(error)
  await server.services.personal.idle()
  return provider
}

const files = () => [...agents.files.entries()].map(([path, content]) => ({ path, content: content.toString() }))

beforeEach(async () => {
  nextMessage = 100
  agents = new FakeAgentSystem()
  telegram = new FakeTelegram()
  providers = fakeProviders()
  server = await startServer({ agents, telegram, terminalsEnabled: true, chatProviders: providers.factory })
  ana = await setupAdmin(server.app)
  bruno = await addMember(server.app, ana.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  const { link } = (await api('POST', '/api/me/notifications/telegram', ana.cookie)).json()
  telegram.queue.push({ update_id: 1, message: { chat: { id: 555 }, text: `/start ${link.code}` } })
  await server.ctx.notifier.pollOnce()
  telegram.sent.length = 0
})

afterEach(async () => {
  await server.close()
})

describe('agente pessoal no Telegram', () => {
  it('guarda o original no cofre na hora e conversa pelo Claude da pessoa, dentro do cofre', async () => {
    await send({ text: 'Ideia: plano de fidelidade para a Clarumi com cashback de 2%' })
    const [note] = files()
    expect(note.path).toBe(`/fake/${ana.userId}/cofre/raw/telegram/2026-11-06/050000-100.md`)
    expect(note.content).toMatch(/^---\nsource: telegram\nreceived: 2026-11-06T08:00:00.000Z\nkind: text\nsha256: [0-9a-f]{64}\n---\n\nIdeia: plano de fidelidade/)

    const provider = await answer('Anotei em [[Clarumi - Ideias]] e liguei a [[Fidelidade]].')
    expect(provider.input.cwd).toBe(`/fake/${ana.userId}/cofre`)
    expect(provider.input.policy).toEqual({
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
      roots: [`/fake/${ana.userId}/cofre`]
    })
    expect(provider.input.instructions).toContain('agente pessoal de Ana')
    expect(provider.input.instructions).toContain('raw/ guarda os originais e nunca é editado')
    expect(provider.sent[0]).toContain('[Telegram · 06/11/2026, 05:00]')
    expect(provider.sent[0]).toContain('Original salvo em raw/telegram/2026-11-06/050000-100.md.')
    expect(telegram.sent.at(-1)).toEqual({ chatId: '555', text: 'Anotei em [[Clarumi - Ideias]] e liguei a [[Fidelidade]].', html: true })
    expect(telegram.typing).toBeGreaterThan(0)

    // A conversa aparece em "Conversas" só para a Ana.
    const chats = (await api('GET', '/api/chats', ana.cookie)).json().chats
    expect(chats).toMatchObject([{ origin: 'telegram', shared: false }])
    expect((await api('GET', '/api/chats', bruno.cookie)).json().chats).toEqual([])

    // A mesma mensagem de novo (reentrega do Telegram) não é guardada nem respondida duas vezes.
    telegram.queue.push({ update_id: 900, message: { message_id: 100, date: 1793952000, chat: { id: 555 }, text: 'Ideia: plano...' } })
    await server.ctx.notifier.pollOnce()
    expect(files()).toHaveLength(1)
    expect(providers.last().sent).toHaveLength(1)
  })

  it('fotos e PDFs vão para o cofre junto da nota; áudio avisa que não tem transcrição', async () => {
    telegram.files.set('foto-grande', Buffer.from('JPEG'))
    telegram.files.set('voz', Buffer.from('OGG'))
    await send({ caption: 'Quadro da reunião', photo: [{ file_id: 'foto-pequena' }, { file_id: 'foto-grande', file_size: 4 }] })
    const paths = files().map((file) => file.path.replace(`/fake/${ana.userId}/cofre/`, ''))
    expect(paths).toEqual(['raw/telegram/2026-11-06/050000-100-foto.jpg', 'raw/telegram/2026-11-06/050000-100.md'])
    expect(files()[1].content).toContain('kind: photo')
    expect(files()[1].content).toContain('![[050000-100-foto.jpg]]')
    const first = await answer('Guardei a foto do quadro.')
    expect(first.sent[0]).toContain('foto em raw/telegram/2026-11-06/050000-100-foto.jpg')

    await send({ voice: { file_id: 'voz', file_size: 3 } })
    const second = await answer('Guardei o áudio.')
    expect(second.sent.at(-1)).toContain('O áudio não tem transcrição.')
  })

  it('mensagem que chega com o agente trabalhando entra na mesma vez', async () => {
    await send({ text: 'Resuma o que eu tenho sobre o Pix' })
    await waitFor(() => providers.created.length === 1)
    await send({ text: 'e inclua as taxas' })
    expect(providers.last().steered).toEqual([expect.stringContaining('e inclua as taxas')])
    expect(files()).toHaveLength(2)
    await answer('Resumo com as taxas.')
    expect(telegram.sent.filter((message) => message.text.includes('Resumo'))).toHaveLength(1)
  })

  it('sem o Claude conectado, avisa que guardou mesmo assim', async () => {
    await send({ text: 'lembrar de pagar o boleto' })
    await answer(null, 'O Claude não está conectado na sua conta.')
    expect(telegram.sent.at(-1)?.text).toContain('Guardei no cofre (raw/telegram/2026-11-06/050000-100.md), mas não consegui falar com o seu Claude')
  })

  it('comandos: /novo, /rotinas, /rodar, /pausar e /ajuda', async () => {
    await send({ text: 'oi' })
    await answer('Oi!')
    await send({ text: '/novo' })
    expect(telegram.sent.at(-1)?.text).toContain('conversa nova')
    await send({ text: 'de novo' })
    await waitFor(() => providers.created.length === 2)
    await answer('Oi de novo!')
    expect(providers.created[0].closed).toBe(true)

    await api('POST', '/api/routines', ana.cookie, { name: 'Resumo da manhã', prompt: 'notícias', schedule: '30 7 * * 1-5' })
    await send({ text: '/rotinas' })
    expect(telegram.sent.at(-1)?.text).toContain('<b>Resumo da manhã</b> — dias úteis às 07:30')
    await send({ text: '/pausar resumo' })
    expect(telegram.sent.at(-1)?.text).toBe('"Resumo da manhã" pausada.')
    expect((await api('GET', '/api/routines', ana.cookie)).json().routines[0].enabled).toBe(false)
    await send({ text: '/rodar nada-disso' })
    expect(telegram.sent.at(-1)?.text).toContain('Não achei a rotina')
    await send({ text: '/rodar Resumo da manhã' })
    expect(telegram.sent.at(-1)?.text).toContain('Rodando "Resumo da manhã"')
    await waitFor(() => providers.created.length === 3)
    expect(providers.last().input.instructions).toContain('rotina agendada "Resumo da manhã"')
    await send({ text: '/ajuda' })
    expect(telegram.sent.at(-1)?.text).toContain('/rodar nome')
  })

  it('quem não vinculou continua recebendo só o pedido de código', async () => {
    telegram.queue.push({ update_id: 50, message: { message_id: 1, chat: { id: 999 }, text: 'oi' } })
    await server.ctx.notifier.pollOnce()
    expect(telegram.sent.at(-1)?.text).toContain('gere um código')
    expect(files()).toEqual([])
  })
})

describe('cofre e Obsidian Sync', () => {
  it('mostra o estado e liga a sincronização contínua de quem configurou o cofre', async () => {
    let status = (await api('GET', '/api/me/vault', ana.cookie)).json()
    expect(status).toMatchObject({ folder: '~/cofre', obsidian: { available: true, configured: false, syncing: false }, telegram: { linked: true }, items: 0 })

    agents.obsidian.set(ana.userId, [`/fake/${ana.userId}/cofre/`])
    status = (await api('GET', '/api/me/vault', ana.cookie)).json()
    expect(status.obsidian).toEqual({ available: true, configured: true, syncing: true })
    expect(agents.running.get('harpia-obsync')).toEqual({
      user: ana.userId,
      cwd: `/fake/${ana.userId}/cofre`,
      command: 'exec ob sync --continuous --path "$HOME/cofre"'
    })

    await send({ text: 'nota rápida' })
    await answer('Ok.')
    status = (await api('GET', '/api/me/vault', ana.cookie)).json()
    expect(status.items).toBe(1)
    expect(status.recent[0]).toMatchObject({ kind: 'text', path: 'raw/telegram/2026-11-06/050000-100.md' })
  })
})
