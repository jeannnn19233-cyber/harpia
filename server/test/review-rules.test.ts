import { describe, expect, it } from 'vitest'
import type { User } from '../../shared/types.ts'
import type { CheckRunInfo, PullDetail, PullReviewInfo } from '../src/github/client.ts'
import { checarTexto, limparAssinatura, linhasComentaveis, mapaDoDiff, PADRAO_ASSINATURA, separarComentarios, validarCommits, validarRevisao } from '../src/reviews/gate.ts'
import { aplicarRodada, novaMemoria } from '../src/reviews/memory.ts'
import { entryLine, parseReviewerResult, reviewerInstructions } from '../src/reviews/prompt.ts'
import { ciFailedTooFast, isApproved, planPull, resolveReviewer, type Person, type PullState, type Team } from '../src/reviews/queues.ts'

function user(id: number, login: string, extra: Partial<User> = {}): User {
  return {
    id,
    name: `Pessoa ${login}`,
    email: `${login}@exemplo.com`,
    role: 'member',
    githubLogin: login,
    githubConnected: true,
    reviewMode: 'full',
    preferredReviewerId: null,
    ...extra
  } as User
}

function team(people: Person[], defaultReviewerId: number | null = null): Team {
  return {
    byLogin: (login) => people.find((person) => person.user.githubLogin?.toLowerCase() === login.toLowerCase()) ?? null,
    byId: (id) => people.find((person) => person.user.id === id) ?? null,
    defaultReviewerId
  }
}

function pull(extra: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 7,
    nodeId: 'PR_7',
    title: 'Pix',
    url: 'https://github.com/clarumi/loja/pull/7',
    body: '',
    draft: false,
    authorLogin: 'ana-dev',
    headSha: 'aaaaaaa1111111',
    headRef: 'pix',
    headRepo: 'clarumi/loja',
    baseRef: 'main',
    labels: [],
    requestedReviewers: [],
    updatedAt: '2026-01-01T00:00:00Z',
    state: 'open',
    mergeable: true,
    mergeableState: 'clean',
    ...extra
  }
}

function state(pr: PullDetail, extra: Partial<PullState> = {}): PullState {
  return { pr, reviews: [], checks: [], baseSha: 'main123', published: new Set(), since: null, ...extra }
}

const ana: Person = { user: user(1, 'ana-dev', { preferredReviewerId: 2 }), bot: true }
const bruno: Person = { user: user(2, 'bruno-rev'), bot: true }
const carla: Person = { user: user(3, 'carla'), bot: true }
const dani: Person = { user: user(4, 'dani', { githubConnected: false }), bot: false }

describe('quem revisa', () => {
  it('quem o autor marcou no GitHub, senão o preferido do autor, senão o padrão do projeto; nunca o autor', () => {
    const everyone = team([ana, bruno, carla, dani], 3)
    expect(resolveReviewer(pull({ requestedReviewers: ['carla'] }), everyone)?.user.id).toBe(3)
    expect(resolveReviewer(pull(), everyone)?.user.id).toBe(2)
    expect(resolveReviewer(pull({ authorLogin: 'bruno-rev' }), everyone)?.user.id).toBe(3)
    // O padrão do projeto é o próprio autor: ninguém revisa sozinho.
    expect(resolveReviewer(pull({ authorLogin: 'carla' }), team([ana, bruno, carla], 3))).toBeNull()
    // O autor marcou uma pessoa que revisa à mão: a escolha dele vale.
    expect(resolveReviewer(pull({ requestedReviewers: ['dani'] }), everyone)).toBeNull()
  })

  it('monta as filas na ordem da skill', () => {
    const everyone = team([ana, bruno, dani])
    expect(planPull(state(pull()), everyone)).toEqual([{ queue: 'revisar', key: 'aaaaaaa1111111', actorId: 2, priority: 5 }])
    expect(planPull(state(pull({ draft: true })), everyone)).toEqual([])

    // Revisor humano marcado: o revisor do autor adianta a análise.
    expect(planPull(state(pull({ requestedReviewers: ['dani'] })), everyone)).toEqual([
      { queue: 'adiantar', key: 'aaaaaaa1111111', actorId: 1, priority: 4 }
    ])

    // Conflito com a main: quem resolve é o revisor do autor; PR já aprovado vem primeiro.
    const approved: PullReviewInfo[] = [{ id: 1, login: 'bruno-rev', state: 'APPROVED', body: 'ok', commitId: 'x', submittedAt: '2026-01-02T00:00:00Z' }]
    const conflict = planPull(state(pull({ mergeableState: 'dirty', mergeable: false }), { reviews: approved, published: new Set([1]) }), everyone)
    expect(conflict[0]).toEqual({ queue: 'conflito', key: 'aaaaaaa1111111:main123', actorId: 1, priority: 1 })

    // Revisão de uma pessoa ainda não tratada: o revisor do autor corrige.
    const human: PullReviewInfo[] = [{ id: 9, login: 'dani', state: 'CHANGES_REQUESTED', body: 'falta teste', commitId: 'x', submittedAt: '2026-01-02T00:00:00Z' }]
    expect(planPull(state(pull(), { reviews: human }), everyone)).toContainEqual({ queue: 'corrigir', key: 'review:9', actorId: 1, priority: 2, reviewId: 9 })
    // Revisão anterior a ligar o revisor não entra.
    expect(planPull(state(pull(), { reviews: human, since: '2026-02-01T00:00:00Z' }), everyone).map((job) => job.queue)).toEqual(['revisar'])
  })

  it('CI que falhou rápido demais vai para RETESTAR; aprovação é a última decisão de cada pessoa', () => {
    const check = (seconds: number): CheckRunInfo => ({
      name: 'testes',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString()
    })
    expect(ciFailedTooFast([check(4)])).toBe(true)
    expect(ciFailedTooFast([check(4), check(300)])).toBe(false)
    expect(planPull(state(pull(), { checks: [check(3)] }), team([ana, bruno])).map((job) => job.queue)).toEqual(['revisar', 'retestar'])

    const review = (login: string, s: PullReviewInfo['state']): PullReviewInfo => ({ id: 1, login, state: s, body: '', commitId: null, submittedAt: null })
    expect(isApproved([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')])).toBe(true)
    expect(isApproved([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')])).toBe(false)
  })
})

describe('portão antes de publicar', () => {
  const memoria = novaMemoria(7)

  it('barra corpo sem hash, marca de ferramenta, segredo e aprovação com bloqueio aberto', () => {
    expect(validarRevisao({ sha: 'abcdef1234', evento: 'COMMENT', corpo: '', comentarios: [], memoria })).toEqual(['CORPO_VAZIO: a revisão precisa de corpo.'])
    expect(validarRevisao({ sha: 'abcdef1234', evento: 'COMMENT', corpo: 'Revisei.', comentarios: [], memoria })[0]).toMatch(/^SEM_HASH/)
    expect(checarTexto('Revisão automática feita pelo Claude', 'corpo')[0]).toMatch(/^MARCA_DE_FERRAMENTA/)
    // Nome de arquivo entre crases é código, não assinatura.
    expect(checarTexto('Mexi em `docs/claude.md`.', 'corpo')).toEqual([])
    expect(checarTexto(`token ghp_${'x'.repeat(30)}`, 'corpo')[0]).toMatch(/^SEGREDO_NO_TEXTO/)
    expect(validarCommits([{ sha: 'abc1234567', message: 'Corrige\n\nCo-Authored-By: Claude <noreply@anthropic.com>' }])[0]).toMatch(/MARCA_DE_FERRAMENTA em commit abc1234/)

    const comBloqueio = aplicarRodada(memoria, [{ resumo: 'SQL injection', gravidade: 'bloqueia', status: 'aberto' }], {
      sha: 'abcdef1234',
      em: '2026-01-01',
      evento: 'REQUEST_CHANGES',
      resumo: ''
    })
    const aprova = (achados: Parameters<typeof validarRevisao>[0]['achadosDaRodada']) =>
      validarRevisao({ sha: 'abcdef1234', evento: 'APPROVE', corpo: 'Aprovo o `abcdef1`.', comentarios: [], memoria: comBloqueio, achadosDaRodada: achados })
    expect(aprova([])[0]).toMatch(/^APROVA_COM_BLOQUEIO: .*A1 \(SQL injection\)/)
    expect(aprova([{ id: 'A1', status: 'resolvido', nota: 'parametrizei' }])).toEqual([])
    expect(aprova([{ id: 'A1', status: 'resolvido' }, { resumo: 'outro', gravidade: 'bloqueia' }])[0]).toMatch(/novo/)
  })

  it('separa os comentários em linha que o GitHub aceita', () => {
    const patch = '@@ -1,2 +1,3 @@\n export const taxa = 0\n-const velho = 1\n+export function total() {\n+}'
    expect([...linhasComentaveis(patch).direita]).toEqual([1, 2, 3])
    expect([...linhasComentaveis(patch).esquerda]).toEqual([1, 2])
    const map = mapaDoDiff([{ filename: 'src/pix.ts', patch }])
    const { aceitos, fora } = separarComentarios(
      [
        { path: 'src/pix.ts', line: 2, body: 'a' },
        { path: 'src/pix.ts', line: 2, side: 'LEFT', body: 'b' },
        { path: 'src/pix.ts', line: 99, body: 'c' },
        { path: 'outro.ts', line: 1, body: 'd' }
      ],
      map
    )
    expect(aceitos.map((item) => item.body)).toEqual(['a', 'b'])
    expect(fora.map((item) => item.body)).toEqual(['c', 'd'])
  })
})

describe('memória por achado', () => {
  it('numera achados novos, guarda o histórico e recusa id inventado', () => {
    let mem = aplicarRodada(novaMemoria(7), [{ arquivo: 'a.ts', linha: 3, resumo: 'X', gravidade: 'bloqueia' }], {
      sha: 's1',
      em: 't1',
      evento: 'REQUEST_CHANGES',
      resumo: 'r1'
    })
    mem = aplicarRodada(mem, [{ id: 'A1', status: 'resolvido', nota: 'corrigido' }, { resumo: 'Y', gravidade: 'nao-bloqueia' }], {
      sha: 's2',
      em: 't2',
      evento: 'APPROVE',
      resumo: 'r2'
    })
    expect(mem.achados.map((achado) => [achado.id, achado.status])).toEqual([
      ['A1', 'resolvido'],
      ['A2', 'aberto']
    ])
    expect(mem.achados[0].historico.map((item) => item.sha)).toEqual(['s1', 's2'])
    expect(mem.rodadas.map((rodada) => rodada.n)).toEqual([1, 2])
    expect(mem.sha_revisado).toBe('s2')
    expect(() => aplicarRodada(mem, [{ id: 'A9', status: 'resolvido' }], { sha: 's3', em: 't3', evento: null, resumo: '' })).toThrow(/não existe/)
    expect(() => aplicarRodada(mem, [{ resumo: 'Z', gravidade: 'bloqueia', status: 'resolvido' }], { sha: 's3', em: 't3', evento: null, resumo: '' })).toThrow(/nasce aberto/)
  })
})

describe('assinatura de ferramenta', () => {
  it('tira só as linhas de assinatura, sem tocar em texto que só cita um produto', () => {
    const body = 'Adiciona o Pix.\n\n## Testes\nok\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
    expect(PADRAO_ASSINATURA.test(body)).toBe(true)
    expect(limparAssinatura(body)).toBe('Adiciona o Pix.\n\n## Testes\nok')
    expect(PADRAO_ASSINATURA.test('O Claude e o ChatGPT nunca aprovam sozinhos.')).toBe(false)
  })
})

describe('instruções e resposta do revisor', () => {
  it('fala na voz da pessoa, explica o que o Harpia faz e lê a resposta em JSON', () => {
    const text = reviewerInstructions({ actor: user(2, 'bruno-rev', { name: 'Bruno Lima' }), login: 'bruno-rev', mode: 'fix', rules: '' })
    expect(text).toContain('sai em nome de Bruno')
    expect(text).toContain('NUNCA aprova')
    expect(text).toContain('Nunca faça merge do PR.')
    expect(text).toContain('## Como revisar')

    expect(parseReviewerResult('sem json')).toBeNull()
    const parsed = parseReviewerResult('```json\n{"revisoes":[{"evento":"COMMENT","corpo":"ok `abc1234`"}],"estado":"revisado-sem-bloqueio"}\n```')
    expect(parsed?.revisoes[0]).toEqual({ commit: 'inicial', evento: 'COMMENT', corpo: 'ok `abc1234`', comentarios: [] })

    expect(
      entryLine({
        queue: 'revisar',
        number: 7,
        sha: 'abc',
        title: 'Pix',
        author: 'ana-dev',
        branch: 'pix',
        draft: false,
        attempts: 0,
        reviewedBefore: 'def4567890',
        impediment: '-'
      })
    ).toBe('REVISAR PR #7 topo=abc revisado_antes=def4567 autor=ana-dev rascunho=false tentativas=0 titulo=Pix')
  })
})
