import type { PrMemory } from '../../../shared/types.ts'
import type { ReviewComment, ReviewEvent } from '../github/client.ts'
import { achadosBloqueantesAbertos, type FindingUpdate } from './memory.ts'

// Portão antes de publicar (port do revisor_checagem.py do Hermes). Barra o que é estrutural e sem
// ambiguidade: SHA_DIVERGENTE, CORPO_VAZIO, SEM_HASH, MARCA_DE_FERRAMENTA, SEGREDO_NO_TEXTO,
// LINHA_FORA_DO_DIFF e APROVA_COM_BLOQUEIO.

export const FERRAMENTA =
  /\b(claude|anthropic|opus|sonnet|haiku|hermes|chatgpt|openai|gpt-?\d\w*|codex|copilot|gemini|\bllm\b)\b|revis(ão|ao|or|ora) autom[aá]tic|gerad[oa]s? automaticamente|feit[oa] por (uma )?ia\b|generated (with|by)|co-authored-by|\b(sou|como) (um|uma) (ia|modelo|assistente|bot)\b/i

export const SEGREDO =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(ant-)?[A-Za-z0-9_-]{20,}|ntn_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@`]+:[^/\s@`]+@/

// O código entre crases não conta para marca de ferramenta (ex.: `specs/agentes/...`).
export function semCodigo(texto: string): string {
  return texto
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

export function checarTexto(texto: string, onde: string): string[] {
  const erros: string[] = []
  if (SEGREDO.test(texto)) erros.push(`SEGREDO_NO_TEXTO em ${onde}: há algo com cara de credencial; tire antes de publicar.`)
  const marca = semCodigo(texto).match(FERRAMENTA)
  if (marca) erros.push(`MARCA_DE_FERRAMENTA em ${onde}: '${marca[0]}'. O texto sai na sua voz; reescreva.`)
  return erros
}

// Linhas aceitas pelo GitHub para comentário: lado RIGHT (arquivo novo) e LEFT (arquivo antigo).
export function linhasComentaveis(patch: string | null): { direita: Set<number>; esquerda: Set<number> } {
  const direita = new Set<number>()
  const esquerda = new Set<number>()
  if (!patch) return { direita, esquerda }
  let d = 0
  let e = 0
  let dentro = false
  for (const ln of patch.split('\n')) {
    const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (m) {
      e = Number(m[1])
      d = Number(m[2])
      dentro = true
      continue
    }
    if (!dentro || ln.startsWith('\\') || ln === '') continue
    if (ln.startsWith('+')) direita.add(d++)
    else if (ln.startsWith('-')) esquerda.add(e++)
    else {
      direita.add(d++)
      esquerda.add(e++)
    }
  }
  return { direita, esquerda }
}

export function mapaDoDiff(files: { filename: string; patch: string | null }[]) {
  return new Map(files.map((file) => [file.filename, linhasComentaveis(file.patch)]))
}

// Separa os comentários em linha que o GitHub aceita dos que precisam ir para o corpo.
export function separarComentarios(comentarios: ReviewComment[], mapa: ReturnType<typeof mapaDoDiff>) {
  const aceitos: ReviewComment[] = []
  const fora: ReviewComment[] = []
  for (const comentario of comentarios) {
    const linhas = mapa.get(comentario.path)
    const lado = comentario.side ?? 'RIGHT'
    const conjunto = linhas ? (lado === 'RIGHT' ? linhas.direita : linhas.esquerda) : null
    if (conjunto?.has(Number(comentario.line))) aceitos.push(comentario)
    else fora.push(comentario)
  }
  return { aceitos, fora }
}

// Validação do texto e do evento de uma revisão antes de publicar (o SHA e as linhas do diff são
// conferidos contra o GitHub na hora de publicar).
export function validarRevisao(input: {
  sha: string
  evento: ReviewEvent
  corpo: string
  comentarios: ReviewComment[]
  memoria: PrMemory
  achadosDaRodada?: FindingUpdate[]
}): string[] {
  const erros: string[] = []
  if (!input.corpo.trim()) erros.push('CORPO_VAZIO: a revisão precisa de corpo.')
  else if (!input.corpo.includes(input.sha.slice(0, 7))) erros.push(`SEM_HASH: o corpo precisa citar o commit revisado (\`${input.sha.slice(0, 7)}\`).`)
  if (input.corpo.trim()) erros.push(...checarTexto(input.corpo, 'corpo'))
  input.comentarios.forEach((comentario, i) => {
    const rotulo = `comentário em linha #${i + 1}`
    if (!comentario.path || !comentario.line || !comentario.body) {
      erros.push(`CAMPO_AUSENTE em ${rotulo}: precisa de path, line e body.`)
      return
    }
    erros.push(...checarTexto(comentario.body, rotulo))
  })
  if (input.evento === 'APPROVE') {
    let bloqueantes = achadosBloqueantesAbertos(input.memoria)
    if (input.achadosDaRodada) {
      const tratados = new Set(input.achadosDaRodada.filter((achado) => achado.status && achado.status !== 'aberto').map((achado) => achado.id))
      bloqueantes = bloqueantes.filter((achado) => !tratados.has(achado.id))
      const novos = input.achadosDaRodada.filter((achado) => !achado.id && achado.gravidade === 'bloqueia' && (achado.status ?? 'aberto') === 'aberto')
      if (novos.length > 0) erros.push(`APROVA_COM_BLOQUEIO: ${novos.length} achado(s) bloqueante(s) novo(s) ainda aberto(s) nesta rodada.`)
    }
    if (bloqueantes.length > 0) {
      erros.push(`APROVA_COM_BLOQUEIO: achado(s) bloqueante(s) aberto(s) na memória: ${bloqueantes.map((achado) => `${achado.id} (${achado.resumo.slice(0, 60)})`).join(', ')}.`)
    }
  }
  return erros
}

// Mensagens de commit também saem na voz de quem publica: sem marca de ferramenta, sem segredo.
export function validarCommits(commits: { sha: string; message: string }[]): string[] {
  return commits.flatMap((commit) => checarTexto(commit.message, `commit ${commit.sha.slice(0, 7)}`))
}

// Padrão estrutural de assinatura de ferramenta (fila ASSINATURA), mais estreito que o do portão:
// nomes soltos de produto ("o Claude e o ChatGPT nunca aprovam") são texto legítimo.
export const PADRAO_ASSINATURA =
  /generated (with|by)\s*\[?claude|\[claude[\s-]?code\]\(|claude\.ai\/code\/session_|claude[\s-]?session\s*:|co-authored-by:.*(claude|anthropic|openai|copilot|codex)|generated (with|by)\s*\[?codex|🤖\s*generated/i

// Tira só as linhas com assinatura (e a linha em branco que sobrar no fim), sem tocar no resto.
export function limparAssinatura(texto: string): string {
  const linhas = texto.split('\n').filter((linha) => !PADRAO_ASSINATURA.test(linha))
  return linhas.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}
