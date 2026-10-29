import { useEffect, useMemo, useState } from 'react'
import { VERDICT_LABELS, type PrReview } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Dialog } from '../Dialogs.tsx'
import { ChatView } from '../task/ChatView.tsx'

const STATUS: Record<PrReview['status'], { label: string; className: string }> = {
  waiting: { label: 'na fila', className: 'bg-zinc-700/50 text-zinc-300' },
  running: { label: 'revisando', className: 'bg-sky-500/15 text-sky-300' },
  posted: { label: 'publicada', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'falhou', className: 'bg-rose-500/15 text-rose-300' },
  skipped: { label: 'pulada', className: 'bg-amber-500/15 text-amber-300' }
}

const VERDICT_STYLE: Record<NonNullable<PrReview['verdict']>, string> = {
  approve: 'text-emerald-300',
  request_changes: 'text-amber-300',
  comment: 'text-zinc-300'
}

function counts(review: PrReview): string {
  if (!review.counts) return ''
  const { critical, warning, suggestion } = review.counts
  return [critical && `${critical} crítico(s)`, warning && `${warning} aviso(s)`, suggestion && `${suggestion} sugestão(ões)`]
    .filter(Boolean)
    .join(' · ')
}

// Revisão automática dos PRs do projeto: cada commit novo é revisado no Claude do autor do PR.
export function ReviewsDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const { me, users, upsertReviews, upsertProject } = useHarpia()
  const project = useHarpia((state) => state.projects.find((item) => item.id === projectId))
  const all = useHarpia((state) => state.reviews)
  const [github, setGithub] = useState(true)
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chatId, setChatId] = useState<number | null>(null)

  useEffect(() => {
    api
      .reviews(projectId)
      .then((result) => {
        upsertReviews(result.reviews)
        setGithub(result.github)
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
      <Dialog title="Conversa da revisão" wide onClose={() => setChatId(null)}>
        <div className="flex h-[70vh] flex-col">
          <ChatView chatId={chatId} />
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Revisão de PRs" wide onClose={onClose}>
      {!github ? (
        <p className="text-sm text-zinc-400">A revisão automática só funciona com repositórios do GitHub.</p>
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
                Cada commit novo de um PR aberto é revisado no Claude de quem abriu o PR (depois de 3 minutos sem commits novos). A revisão
                sai no GitHub como comentário, com observações nas linhas, e um resumo vai para o Telegram do autor. Nunca aprova: a aprovação
                continua sendo de uma pessoa. Rascunhos e PRs com o rótulo <code>sem-revisao-ia</code> ficam de fora.
              </span>
            </span>
          </label>
          {!me?.githubLogin && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              Informe o seu usuário do GitHub em "Minhas IAs" para os seus PRs serem revisados no seu Claude.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-zinc-400">Revisar agora, com o meu Claude, o PR nº</span>
            <input
              className="input w-24"
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="12"
            />
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
            <p className="text-sm text-zinc-500">Nenhuma revisão ainda.</p>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {reviews.map((review) => {
                const status = STATUS[review.status]
                const reviewer = review.reviewerId ? users[review.reviewerId] : null
                return (
                  <li key={review.id} className="px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${status.className}`}>{status.label}</span>
                      <a href={review.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        #{review.number} {review.title}
                      </a>
                      <span className="text-xs text-zinc-500">
                        @{review.authorLogin} · {review.headSha.slice(0, 7)} · {timeAgo(review.updatedAt)}
                        {reviewer && ` · Claude de ${reviewer.name.split(' ')[0]}`}
                      </span>
                      <span className="ml-auto flex gap-1">
                        {review.reviewUrl && (
                          <a className="btn-ghost px-2 py-0.5 text-xs" href={review.reviewUrl} target="_blank" rel="noreferrer">
                            no GitHub
                          </a>
                        )}
                        {review.chatId && (
                          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setChatId(review.chatId)}>
                            conversa
                          </button>
                        )}
                      </span>
                    </div>
                    {review.verdict && (
                      <p className="mt-1 text-xs">
                        <span className={VERDICT_STYLE[review.verdict]}>Veredito da IA: {VERDICT_LABELS[review.verdict]}</span>
                        {counts(review) && <span className="text-zinc-500"> · {counts(review)}</span>}
                      </p>
                    )}
                    {review.summary && <p className="mt-1 text-xs text-zinc-400">{review.summary}</p>}
                    {review.error && <p className="mt-1 text-xs text-rose-300">{review.error}</p>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  )
}
