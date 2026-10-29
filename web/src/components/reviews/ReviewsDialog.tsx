import { useEffect, useMemo, useState } from 'react'
import { PR_QUEUE_LABELS, VERDICT_LABELS, type PrMemory, type PrReview, type ProjectReviewSettings } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Dialog } from '../Dialogs.tsx'
import { ChatView } from '../task/ChatView.tsx'

const STATUS: Record<PrReview['status'], { label: string; className: string }> = {
  waiting: { label: 'na fila', className: 'bg-zinc-700/50 text-zinc-300' },
  running: { label: 'trabalhando', className: 'bg-sky-500/15 text-sky-300' },
  posted: { label: 'feito', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'falhou', className: 'bg-rose-500/15 text-rose-300' },
  skipped: { label: 'pulado', className: 'bg-amber-500/15 text-amber-300' }
}

const VERDICT_STYLE: Record<NonNullable<PrReview['verdict']>, string> = {
  approve: 'text-emerald-300',
  request_changes: 'text-amber-300',
  comment: 'text-zinc-300'
}

function counts(review: PrReview): string {
  if (!review.counts) return ''
  const { critical, warning } = review.counts
  return [critical && `${critical} bloqueio(s) aberto(s)`, warning && `${warning} ponto(s) que não bloqueiam`].filter(Boolean).join(' · ')
}

// Memória por achado de um PR: o que já foi apontado, em que rodada, e o que já foi resolvido.
function MemoryView({ projectId, number }: { projectId: number; number: number }) {
  const [memory, setMemory] = useState<PrMemory | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .pullMemory(projectId, number)
      .then((result) => setMemory(result.memory))
      .catch((err: Error) => setError(err.message))
  }, [projectId, number])
  if (error) return <p className="mt-2 text-xs text-rose-300">{error}</p>
  if (!memory) return <p className="mt-2 text-xs text-zinc-500">Carregando…</p>
  if (memory.achados.length === 0) return <p className="mt-2 text-xs text-zinc-500">Nenhum achado guardado para este PR.</p>
  return (
    <ul className="mt-2 space-y-1 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs">
      {memory.achados.map((achado) => (
        <li key={achado.id} className={achado.status === 'aberto' ? '' : 'text-zinc-500'}>
          <b>{achado.id}</b> · {achado.gravidade === 'bloqueia' ? 'bloqueia' : 'não bloqueia'} · {achado.status} — {achado.resumo}
          {achado.arquivo && (
            <code className="ml-1">
              {achado.arquivo}
              {achado.linha ? `:${achado.linha}` : ''}
            </code>
          )}
        </li>
      ))}
      <li className="pt-1 text-zinc-500">{memory.rodadas.length} rodada(s) de revisão.</li>
    </ul>
  )
}

function QuestionForm({ review, onDone }: { review: PrReview; onDone: (review: PrReview) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-2">
        <input className="input" value={text} placeholder="Sua decisão" onChange={(e) => setText(e.target.value)} />
        <button
          className="btn-primary py-1.5"
          disabled={!text.trim()}
          onClick={() =>
            void api
              .answerReview(review.id, text.trim())
              .then((result) => onDone(result.review))
              .catch((err: Error) => setError(err.message))
          }
        >
          Responder
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  )
}

// Configuração do revisor no projeto: quem revisa por padrão e as regras (a "skill" do revisor).
function Settings({ projectId, settings, onSaved }: { projectId: number; settings: ProjectReviewSettings; onSaved: (settings: ProjectReviewSettings) => void }) {
  const { users } = useHarpia()
  const [rules, setRules] = useState(settings.rules)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ error: string | null; saved: boolean }>({ error: null, saved: false })
  const save = async (input: { defaultReviewerId?: number | null; rules?: string }) => {
    try {
      onSaved((await api.updateReviewSettings(projectId, input)).settings)
      setState({ error: null, saved: true })
    } catch (err) {
      setState({ error: (err as Error).message, saved: false })
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 px-4 py-3 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">Revisor padrão do projeto (quando o autor não marcou ninguém nem escolheu um preferido):</span>
        <select
          className="input w-auto"
          value={settings.defaultReviewerId ?? ''}
          onChange={(e) => void save({ defaultReviewerId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Ninguém</option>
          {Object.values(users).map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
              {user.githubConnected ? '' : ' (sem GitHub conectado)'}
            </option>
          ))}
        </select>
      </label>
      <div>
        <button className="text-left text-zinc-300 hover:underline" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Regras do revisor deste projeto {settings.rules.trim() ? '' : '(usando as regras gerais)'}
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-zinc-400">
              Cole aqui a skill do revisor (checklist, formato das revisões, o que bloqueia). Fica só no servidor do Harpia, nunca no
              repositório. Vazio = regras gerais de segurança e boas práticas.
            </p>
            <textarea
              className="input h-72 font-mono text-xs"
              value={rules}
              onChange={(e) => {
                setRules(e.target.value)
                setState({ error: null, saved: false })
              }}
            />
            <div className="flex items-center gap-2">
              <button className="btn-primary py-1.5" disabled={rules === settings.rules} onClick={() => void save({ rules })}>
                Salvar regras
              </button>
              {state.saved && <span className="text-xs text-emerald-400">Salvo</span>}
            </div>
          </div>
        )}
      </div>
      {state.error && <p className="text-xs text-rose-300">{state.error}</p>}
    </div>
  )
}

// Revisor de PRs do projeto: cada pessoa tem o próprio revisor (o Claude e o GitHub dela). Quem revisa
// um PR é um colega, nunca o autor.
export function ReviewsDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const { me, users, upsertReviews, upsertProject } = useHarpia()
  const project = useHarpia((state) => state.projects.find((item) => item.id === projectId))
  const all = useHarpia((state) => state.reviews)
  const [github, setGithub] = useState(true)
  const [settings, setSettings] = useState<ProjectReviewSettings | null>(null)
  const [lessons, setLessons] = useState<string[]>([])
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chatId, setChatId] = useState<number | null>(null)
  const [memoryOf, setMemoryOf] = useState<number | null>(null)

  useEffect(() => {
    api
      .reviews(projectId)
      .then((result) => {
        upsertReviews(result.reviews)
        setGithub(result.github)
        setSettings(result.settings)
        setLessons(result.lessons)
      })
      .catch((err: Error) => setError(err.message))
  }, [projectId, upsertReviews])

  const reviews = useMemo(() => Object.values(all).filter((review) => review.projectId === projectId).sort((a, b) => b.id - a.id), [all, projectId])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (chatId) {
    return (
      <Dialog title="Conversa do revisor" wide onClose={() => setChatId(null)}>
        <div className="flex h-[70vh] flex-col">
          <ChatView chatId={chatId} />
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Revisão de PRs" wide onClose={onClose}>
      {!github ? (
        <p className="text-sm text-zinc-400">O revisor só funciona com repositórios do GitHub.</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-3 rounded-lg border border-zinc-800 px-4 py-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={project?.prReview ?? false}
              disabled={busy}
              onChange={(e) => void run(async () => upsertProject((await api.setProjectReview(projectId, e.target.checked)).project))}
            />
            <span className="text-sm">
              <span className="font-medium">Revisar os PRs automaticamente</span>
              <span className="block text-zinc-400">
                A cada 5 minutos o Harpia olha os PRs abertos. Quem revisa é quem o autor marcou no GitHub; senão o revisor preferido do autor;
                senão o padrão do projeto — nunca o próprio autor. O revisor dessa pessoa analisa no Claude dela, corrige numa cópia do PR, roda
                os testes, e o Harpia confere tudo antes de enviar os commits (push normal, nunca forçado) e publicar no GitHub com o token
                dela. Também resolve conflito com a branch principal, responde revisões de pessoas nos PRs de quem tem o revisor ligado e tira
                assinatura de ferramenta do texto. Nunca faz merge. Rascunhos e PRs com o rótulo <code>sem-revisao-ia</code> ficam de fora.
              </span>
            </span>
          </label>
          {me && !me.githubConnected && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              Conecte o seu GitHub em "Minhas IAs" para ter o seu revisor.
            </p>
          )}
          {settings && <Settings projectId={projectId} settings={settings} onSaved={setSettings} />}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-zinc-400">Revisar agora, com o meu revisor, o PR nº</span>
            <input className="input w-24" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} placeholder="12" />
            <button
              className="btn-primary py-1.5"
              disabled={busy || !number}
              onClick={() => void run(async () => upsertReviews([(await api.requestReview(projectId, Number(number))).review]))}
            >
              Revisar
            </button>
            <button className="btn-ghost ml-auto py-1.5" disabled={busy} onClick={() => void run(async () => upsertReviews((await api.checkReviews(projectId)).reviews))}>
              Verificar PRs agora
            </button>
          </div>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          {reviews.length === 0 ? (
            <p className="text-sm text-zinc-500">Nada ainda.</p>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {reviews.map((review) => {
                const status = STATUS[review.status]
                const reviewer = review.reviewerId ? users[review.reviewerId] : null
                const mine = review.reviewerId === me?.id
                const canRetry = review.queue !== 'assinatura' && (review.status === 'failed' || review.status === 'skipped') && (mine || me?.role === 'admin')
                return (
                  <li key={review.id} className="px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${status.className}`}>{status.label}</span>
                      <span className="text-xs text-zinc-400">{PR_QUEUE_LABELS[review.queue]}</span>
                      <a href={review.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        #{review.number} {review.title}
                      </a>
                      <span className="text-xs text-zinc-500">
                        @{review.authorLogin} · {review.headSha.slice(0, 7)} · {timeAgo(review.updatedAt)}
                        {reviewer && ` · revisor de ${reviewer.name.split(' ')[0]}`}
                        {review.attempts > 0 && ` · tentativa ${review.attempts}/3`}
                      </span>
                      <span className="ml-auto flex gap-1">
                        {review.reviewUrl && (
                          <a className="btn-ghost px-2 py-0.5 text-xs" href={review.reviewUrl} target="_blank" rel="noreferrer">
                            no GitHub
                          </a>
                        )}
                        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setMemoryOf(memoryOf === review.id ? null : review.id)}>
                          achados
                        </button>
                        {review.chatId && (
                          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setChatId(review.chatId)}>
                            conversa
                          </button>
                        )}
                        {canRetry && (
                          <button
                            className="btn-ghost px-2 py-0.5 text-xs"
                            disabled={busy}
                            onClick={() => void run(async () => upsertReviews([(await api.retryReview(review.id)).review]))}
                          >
                            tentar de novo
                          </button>
                        )}
                      </span>
                    </div>
                    {review.verdict && (
                      <p className="mt-1 text-xs">
                        <span className={VERDICT_STYLE[review.verdict]}>{VERDICT_LABELS[review.verdict]}</span>
                        {counts(review) && <span className="text-zinc-500"> · {counts(review)}</span>}
                        {review.pushedSha && <span className="text-zinc-500"> · enviei as correções no {review.pushedSha.slice(0, 7)}</span>}
                      </p>
                    )}
                    {review.line && <p className="mt-1 text-xs text-zinc-400">{review.line}</p>}
                    {review.question && (
                      <div className="mt-2 rounded border border-sky-500/30 bg-sky-950/20 px-3 py-2 text-xs">
                        <p className="text-sky-200">❓ {review.question}</p>
                        {review.answer ? (
                          <p className="mt-1 text-zinc-400">Resposta: {review.answer}</p>
                        ) : mine ? (
                          <QuestionForm review={review} onDone={(updated) => upsertReviews([updated])} />
                        ) : (
                          <p className="mt-1 text-zinc-500">Esperando {reviewer?.name.split(' ')[0] ?? 'a pessoa'} responder.</p>
                        )}
                      </div>
                    )}
                    {review.error && <p className="mt-1 text-xs text-rose-300">{review.error}</p>}
                    {memoryOf === review.id && <MemoryView projectId={projectId} number={review.number} />}
                  </li>
                )
              })}
            </ul>
          )}
          {lessons.length > 0 && (
            <details className="rounded-lg border border-zinc-800 px-4 py-3 text-sm">
              <summary className="cursor-pointer text-zinc-300">Lições que o revisor guardou ({lessons.length})</summary>
              <ul className="mt-2 space-y-1 text-xs text-zinc-400">
                {lessons.map((lesson, i) => (
                  <li key={i}>{lesson.replace(/^- /, "")}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  )
}
