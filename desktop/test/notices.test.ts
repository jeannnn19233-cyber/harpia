import { describe, expect, it } from 'vitest'
import type { Chat } from '../../shared/types.ts'
import { noticesFor, waitingCount } from '../../web/src/lib/desktop-notices.ts'

function chat(id: number, extra: Partial<Chat>): Chat {
  return {
    id,
    taskId: 7,
    userId: 1,
    provider: 'claude',
    title: 'Nova conversa',
    status: 'idle',
    permissionMode: 'default',
    branch: null,
    suggestion: null,
    model: null,
    shared: false,
    origin: 'user',
    createdAt: '',
    updatedAt: '',
    ...extra
  } as Chat
}

const title = (taskId: number | null) => (taskId === 7 ? 'T-7 · Checkout com Pix' : null)

describe('avisos do app de computador', () => {
  it('avisa quando o agente da pessoa para para pedir aprovação ou termina', () => {
    const before = { 1: chat(1, { status: 'working' }), 2: chat(2, { status: 'working', provider: 'codex', taskId: null, title: 'Ideias' }) }
    const after = { 1: chat(1, { status: 'waiting' }), 2: chat(2, { status: 'idle', provider: 'codex', taskId: null, title: 'Ideias' }) }
    expect(noticesFor(before, after, 1, title)).toEqual([
      { title: 'Claude pede aprovação', body: 'T-7 · Checkout com Pix', taskId: 7 },
      { title: 'Codex terminou', body: 'Ideias', taskId: null }
    ])
  })

  it('não avisa do agente dos outros, de rotinas e revisões, nem de mudança que não sai de "trabalhando"', () => {
    const before = {
      1: chat(1, { status: 'working', userId: 2 }),
      2: chat(2, { status: 'working', origin: 'routine' }),
      3: chat(3, { status: 'idle' }),
      4: chat(4, { status: 'working' })
    }
    const after = {
      1: chat(1, { status: 'waiting', userId: 2 }),
      2: chat(2, { status: 'idle', origin: 'routine' }),
      3: chat(3, { status: 'working' }),
      4: chat(4, { status: 'working' })
    }
    expect(noticesFor(before, after, 1, title)).toEqual([])
  })

  it('o contador do ícone conta só as aprovações esperando a própria pessoa', () => {
    const chats = {
      1: chat(1, { status: 'waiting' }),
      2: chat(2, { status: 'waiting', userId: 2 }),
      3: chat(3, { status: 'waiting', origin: 'review' }),
      4: chat(4, { status: 'working' })
    }
    expect(waitingCount(chats, 1)).toBe(1)
  })
})
