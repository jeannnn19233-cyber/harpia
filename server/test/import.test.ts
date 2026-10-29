import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cardDescription, mapStatus, ownerFor } from '../src/tasks/import.ts'
import { addMember, setupAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
let admin: { cookie: string; userId: number }
let bruno: { cookie: string; userId: number }
let projectId: number

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) {
  return server.app.inject({ method, url, headers: { cookie }, payload })
}

// Quadro de exemplo no formato exportado (os dados reais do Clarumi não entram no repositório).
function card(id: string, extra: Record<string, string> = {}) {
  return {
    id,
    titulo: `Tarefa ${id}`,
    fase: 'Semanas 5–6',
    periodo: '2026-10-26 a 2026-11-06',
    dono: 'Ana',
    status: 'A fazer',
    horas: '—',
    etiqueta: '',
    depende_de: '',
    objetivo: `Objetivo da ${id}.`,
    passos: 'Primeiro passo | Segundo passo',
    como_testar: 'Abrir a tela.',
    pronto_quando: 'Tudo verde.',
    arquivos: '',
    ultima_nota: '',
    nota_completa: '',
    atualizado_em: '',
    atualizado_por: '',
    ...extra
  }
}

const board = () => ({
  geradoEm: '2026-10-29T21:54:02.227Z',
  tarefas: [
    card('F1', { status: 'Feito', titulo: 'Base fiscal em homologação' }),
    card('J15', { status: 'Bloqueado', titulo: 'Fechar o cliente-piloto', ultima_nota: '17/10: depende do Portão 1.', nota_completa: '17/10: depende do Portão 1.' }),
    card('J88', { status: 'Fazendo', dono: 'Bruno', depende_de: 'J15', etiqueta: 'fiscal' }),
    card('L21', { dono: 'Layse' }),
    card('J214', { dono: 'A definir' })
  ]
})

beforeEach(async () => {
  server = await startServer()
  admin = await setupAdmin(server.app)
  bruno = await addMember(server.app, admin.cookie, 'Bruno Lima', 'bruno@exemplo.com')
  projectId = (await api('POST', '/api/projects', admin.cookie, { name: 'Clarumi', repoUrl: 'https://github.com/exemplo/clarumi.git' })).json().project.id
})

afterEach(async () => {
  await server.close()
})

async function tasks() {
  return (await api('GET', `/api/projects/${projectId}/tasks`, admin.cookie)).json().tasks as {
    id: number
    title: string
    description: string
    status: string
    ownerId: number | null
  }[]
}

describe('importar quadro de tarefas', () => {
  it('mostra a prévia sem gravar, importa com status, dono e histórico, e só administrador importa', async () => {
    const preview = await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, board())
    expect(preview.statusCode).toBe(200)
    // Por padrão, só as abertas: a feita fica de fora.
    expect(preview.json().plan).toEqual({
      create: 4,
      update: 0,
      unchanged: 0,
      byStatus: { backlog: 3, in_progress: 1, review: 0, done: 0 },
      unknownOwners: ['Layse'],
      invalid: [],
      skippedDone: 1
    })
    expect(await tasks()).toEqual([])

    expect((await api('POST', `/api/projects/${projectId}/import`, bruno.cookie, board())).statusCode).toBe(403)

    const result = await api('POST', `/api/projects/${projectId}/import`, admin.cookie, { ...board(), incluirFeitas: true })
    expect(result.statusCode).toBe(200)
    expect(result.json().plan).toMatchObject({ create: 5, skippedDone: 0 })

    const byTitle = Object.fromEntries((await tasks()).map((task) => [task.title.split(' · ')[0], task]))
    expect(byTitle.F1).toMatchObject({ title: 'F1 · Base fiscal em homologação', status: 'done', ownerId: admin.userId })
    expect(byTitle.J15).toMatchObject({ status: 'backlog' })
    expect(byTitle.J15.description).toContain('**Bloqueado** no quadro de origem')
    expect(byTitle.J15.description).toContain('## Notas\n\n17/10: depende do Portão 1.')
    expect(byTitle.J88).toMatchObject({ status: 'in_progress', ownerId: bruno.userId })
    expect(byTitle.J88.description).toContain('**Depende de:** J15')
    expect(byTitle.J88.description).toContain('## Passos\n\n- Primeiro passo\n- Segundo passo')
    // Quem não tem conta fica sem responsável, com o nome na descrição.
    expect(byTitle.L21).toMatchObject({ status: 'backlog', ownerId: null })
    expect(byTitle.L21.description).toContain('**Dono:** Layse')
    expect(byTitle.J214.ownerId).toBeNull()

    const events = (await api('GET', `/api/tasks/${byTitle.F1.id}`, admin.cookie)).json().events as { type: string; data: Record<string, unknown> }[]
    expect(events.map((event) => [event.type, event.data.importedFrom ?? event.data.reason ?? null])).toEqual([
      ['created', 'F1'],
      ['status_changed', 'import']
    ])
  })

  it('reimportar não duplica, atualiza o que mudou na origem e preserva o que a equipe mudou no Harpia', async () => {
    await api('POST', `/api/projects/${projectId}/import`, admin.cookie, { ...board(), incluirFeitas: true })
    const first = await tasks()

    // A equipe muda uma task no Harpia; na origem, outro cartão muda.
    const l21 = first.find((task) => task.title.startsWith('L21'))!
    await api('PATCH', `/api/tasks/${l21.id}`, admin.cookie, { title: 'L21 · Tela do que o agente fez (escopo novo)' })
    const changed = board()
    changed.tarefas[2] = { ...changed.tarefas[2], status: 'Feito', ultima_nota: 'PR mergeada.', nota_completa: 'PR mergeada.' }

    const preview = (await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, changed)).json().plan
    // A F1 já estava no Harpia: continua sendo acompanhada mesmo sem "incluir feitas".
    expect(preview).toMatchObject({ create: 0, update: 1, unchanged: 4, skippedDone: 0 })
    await api('POST', `/api/projects/${projectId}/import`, admin.cookie, changed)

    const after = await tasks()
    expect(after).toHaveLength(5)
    expect(after.find((task) => task.title.startsWith('J88'))).toMatchObject({ status: 'done' })
    expect(after.find((task) => task.id === l21.id)?.title).toBe('L21 · Tela do que o agente fez (escopo novo)')
  })

  it('quem ganha conta depois recebe as tasks dela na reimportação, sem mexer no resto', async () => {
    await api('POST', `/api/projects/${projectId}/import`, admin.cookie, board())
    const l21 = (await tasks()).find((task) => task.title.startsWith('L21'))!
    await api('PATCH', `/api/tasks/${l21.id}`, admin.cookie, { description: 'Descrição reescrita pela equipe.' })
    const layse = await addMember(server.app, admin.cookie, 'Layse Gomes', 'layse@exemplo.com')
    expect((await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, board())).json().plan).toMatchObject({ update: 1, unknownOwners: [] })
    await api('POST', `/api/projects/${projectId}/import`, admin.cookie, board())
    const after = (await tasks()).find((task) => task.id === l21.id)!
    expect(after).toMatchObject({ ownerId: layse.userId, description: 'Descrição reescrita pela equipe.' })
  })

  it('adota a task que outro importador criou com o código no título, sem duplicar', async () => {
    const made = (await api('POST', `/api/projects/${projectId}/tasks`, admin.cookie, { title: 'J88 · Tarefa J88', description: 'criada pelo script' })).json().task
    await api('POST', `/api/projects/${projectId}/tasks`, admin.cookie, { title: 'Sem código no título' })
    const plan = (await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, board())).json().plan
    expect(plan).toMatchObject({ create: 3, update: 1 })
    await api('POST', `/api/projects/${projectId}/import`, admin.cookie, board())
    const all = await tasks()
    expect(all.filter((task) => task.title.startsWith('J88'))).toHaveLength(1)
    expect(all.find((task) => task.id === made.id)).toMatchObject({ status: 'in_progress', ownerId: bruno.userId })
    // Na próxima rodada ela já é reconhecida pelo código guardado.
    expect((await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, board())).json().plan).toMatchObject({ create: 0, update: 0 })
  })

  it('recusa arquivo fora do formato e aponta cartões com problema', async () => {
    const wrong = await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, { cards: [] })
    expect(wrong.statusCode).toBe(400)
    const odd = board()
    odd.tarefas.push(card('X1', { status: 'Arquivado' }), card('F1'))
    const plan = (await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, odd)).json().plan
    expect(plan.invalid).toEqual([
      { id: 'X1', reason: 'status desconhecido: "Arquivado"' },
      { id: 'F1', reason: 'código repetido no arquivo' }
    ])
    // Arquivo grande (o quadro real tem perto de 1 MB) passa do limite padrão do corpo.
    const big = board()
    big.tarefas[0] = { ...big.tarefas[0], objetivo: 'x'.repeat(1_500_000) }
    expect((await api('POST', `/api/projects/${projectId}/import/preview`, admin.cookie, big)).statusCode).toBe(200)
  })

  it('regras de status, dono e descrição', () => {
    expect([mapStatus('Feito'), mapStatus('fazendo'), mapStatus('Bloqueado'), mapStatus('A fazer'), mapStatus('Revisão'), mapStatus('?')]).toEqual([
      'done',
      'in_progress',
      'backlog',
      'backlog',
      'review',
      null
    ])
    const users = [
      { id: 1, name: 'Jean Richard' },
      { id: 2, name: 'Layse Gomes' },
      { id: 3, name: 'Layse Souza' }
    ] as Parameters<typeof ownerFor>[1]
    expect(ownerFor('Jean', users)).toBe(1)
    expect(ownerFor('jéan', users)).toBe(1)
    // Duas pessoas com o mesmo primeiro nome: melhor sem responsável do que o errado.
    expect(ownerFor('Layse', users)).toBeNull()
    expect(ownerFor('A definir', users)).toBeNull()
    const description = cardDescription(card('J1', { objetivo: '', passos: '', como_testar: '', pronto_quando: '', horas: '4' }), true)
    expect(description).toBe('**Fase:** Semanas 5–6 (2026-10-26 a 2026-11-06) · **Horas:** 4\n\n_Importada do quadro de origem (J1)._')
  })
})
