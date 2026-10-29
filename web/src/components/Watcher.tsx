import { LearningCard, usePendingLearnings } from './insights/Insights.tsx'
import { useEffect, useMemo, useState } from 'react'
import { FINDING_LABELS, PROJECT_MEMORY_LIMIT, type Finding, type NotificationSettings } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { timeAgo } from '../lib/format.ts'
import { useHarpia } from '../lib/store.ts'
import { Dialog } from './Dialogs.tsx'

const KIND_STYLE: Record<Finding['kind'], string> = {
  stale: 'border-amber-700 text-amber-300',
  review_without_pr: 'border-violet-700 text-violet-300',
  file_overlap: 'border-rose-700 text-rose-300',
  duplicate: 'border-sky-700 text-sky-300'
}

export function useOpenFindings(projectId: number | null, taskId?: number): Finding[] {
  const findings = useHarpia((state) => state.findings)
  return useMemo(
    () =>
      Object.values(findings)
        .filter(
          (finding) =>
            finding.status === 'open' &&
            finding.projectId === projectId &&
            (taskId === undefined || finding.taskIds.includes(taskId))
        )
        .sort((a, b) => b.id - a.id),
    [findings, projectId, taskId]
  )
}

export function FindingCard({
  finding,
  compact = false,
  onOpen
}: {
  finding: Finding
  compact?: boolean
  onOpen?: () => void
}) {
  const { tasks, openTask, upsertFindings } = useHarpia()
  const dismiss = async () => upsertFindings([(await api.dismissFinding(finding.id)).finding])
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${KIND_STYLE[finding.kind]}`}>
          {FINDING_LABELS[finding.kind]}
        </span>
        <span className="text-xs text-zinc-500">{timeAgo(finding.createdAt)}</span>
        <button className="ml-auto text-xs text-zinc-500 hover:text-zinc-300" onClick={() => void dismiss()}>
          Dispensar
        </button>
      </div>
      <p className="text-zinc-300">{finding.message}</p>
      {!compact && (
        <div className="mt-2 flex flex-wrap gap-1">
          {finding.taskIds.map((taskId) => (
            <button
              key={taskId}
              className="btn-ghost px-2 py-0.5 text-xs text-brand-400"
              onClick={() => {
                openTask(taskId)
                onOpen?.()
              }}
            >
              Abrir T-{tasks[taskId]?.number ?? '?'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TelegramSection({
  title = 'Avisos no Telegram',
  linkedText = 'Você recebe os avisos do vigia e dos seus agentes quando não está com o Harpia aberto.',
  bordered = true,
  linkLabel = 'Receber avisos no Telegram'
}: { title?: string; linkedText?: string; bordered?: boolean; linkLabel?: string } = {}) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [link, setLink] = useState<{ code: string; url: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    api
      .notifications()
      .then(({ settings }) => setSettings(settings))
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void load()
  }, [])

  if (!settings) return null
  const telegram = settings.telegram
  return (
    <section className={bordered ? 'border-t border-zinc-800 pt-4' : ''}>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {!telegram.available ? (
        <p className="text-sm text-zinc-500">
          O Telegram ainda não foi configurado. Peça ao administrador para habilitar os avisos.
        </p>
      ) : telegram.linked ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-emerald-400">Vinculado</span>
          <span className="text-zinc-500">{linkedText}</span>
          <button className="btn-ghost ml-auto px-2 py-1 text-xs" onClick={() => void api.unlinkTelegram().then(load)}>
            Desvincular
          </button>
        </div>
      ) : link ? (
        <div className="space-y-2 text-sm text-zinc-400">
          {link.url ? (
            <p>
              Abra{' '}
              <a href={link.url} target="_blank" rel="noreferrer" className="text-brand-400 underline">
                este link no Telegram
              </a>{' '}
              e toque em "Iniciar".
            </p>
          ) : (
            <p>Mande este código para o bot @{telegram.botUsername ?? 'do Harpia'}:</p>
          )}
          <p className="font-mono text-lg tracking-widest text-zinc-100">{link.code}</p>
          <p className="text-xs">O código vale por 15 minutos.</p>
          <button className="btn-outline py-1 text-xs" onClick={() => void load()}>
            Já mandei
          </button>
        </div>
      ) : (
        <button
          className="btn-outline py-1.5 text-sm"
          onClick={() =>
            void api
              .linkTelegram()
              .then(({ link }) => setLink(link))
              .catch((err: Error) => setError(err.message))
          }
        >
          {linkLabel}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
    </section>
  )
}

// Painel do vigia: avisos abertos do projeto e o vínculo com o Telegram.
function PendingLearnings({ projectId }: { projectId: number }) {
  const learnings = usePendingLearnings(projectId)
  if (learnings.length === 0) return null
  return (
    <section className="mb-4 space-y-2 border-t border-zinc-800 pt-4">
      <h3 className="text-sm font-semibold">Aprendizados esperando aprovação</h3>
      <p className="text-xs text-zinc-400">
        Sugeridos pela IA ao fim das tasks. Aprovados, vão para o AGENTS.md do repositório (por PR) ou para a memória do projeto.
      </p>
      {learnings.map((learning) => (
        <LearningCard key={learning.id} learning={learning} showTask />
      ))}
    </section>
  )
}

export function WatcherDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const upsertFindings = useHarpia((state) => state.upsertFindings)
  const findings = useOpenFindings(projectId)
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      upsertFindings((await api.checkFindings(projectId)).findings)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Dialog title="Vigia" onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-3">
        <p className="flex-1 text-sm text-zinc-400">
          O vigia confere as tasks a cada 5 minutos: tasks paradas, em Revisão sem PR, parecidas (confirmadas pelo Claude de quem
          criou a task), e pessoas alterando os mesmos arquivos. Ao concluir uma task, ele escreve o resumo e sugere aprendizados.
        </p>
        <button className="btn-outline shrink-0 py-1.5 text-sm" disabled={checking} onClick={() => void check()}>
          {checking ? 'Verificando…' : 'Verificar agora'}
        </button>
      </div>
      <div className="mb-4 max-h-[50vh] space-y-2 overflow-y-auto">
        {findings.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">Nenhum aviso aberto. Tudo em ordem.</p>
        ) : (
          findings.map((finding) => <FindingCard key={finding.id} finding={finding} onOpen={onClose} />)
        )}
      </div>
      <PendingLearnings projectId={projectId} />
      <TelegramSection />
    </Dialog>
  )
}

// Memória do projeto: o que todo agente deve saber ao começar uma conversa.
export function MemoryDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const users = useHarpia((state) => state.users)
  const [body, setBody] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ updatedBy: number | null; updatedAt: string | null }>({
    updatedBy: null,
    updatedAt: null
  })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .memory(projectId)
      .then(({ memory }) => {
        setBody(memory.body)
        setMeta(memory)
      })
      .catch((err: Error) => setError(err.message))
  }, [projectId])

  const save = async () => {
    if (body === null) return
    try {
      const { memory } = await api.saveMemory(projectId, body)
      setMeta(memory)
      setSaved(true)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog title="Memória do projeto" onClose={onClose} wide>
      <p className="mb-3 text-sm text-zinc-400">
        Tudo o que está aqui entra no início de cada conversa nova com o Claude e o Codex neste projeto, junto com a
        task. Escreva regras curtas e duradouras: comandos, convenções, armadilhas. O que é de uma task só fica na
        descrição dela.
      </p>
      {body === null ? (
        <p className="text-sm text-zinc-500">Carregando…</p>
      ) : (
        <>
          <textarea
            className="input min-h-64 font-mono text-xs"
            value={body}
            maxLength={PROJECT_MEMORY_LIMIT}
            placeholder={
              'Ex.:\n- Use pnpm, não npm.\n- Rode pnpm test antes de entregar.\n- Nunca altere migrações antigas do banco.'
            }
            onChange={(e) => {
              setBody(e.target.value)
              setSaved(false)
            }}
          />
          <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
            <span>
              {body.length} de {PROJECT_MEMORY_LIMIT} caracteres
            </span>
            {meta.updatedAt && (
              <span>
                · editada por {meta.updatedBy ? (users[meta.updatedBy]?.name ?? 'alguém') : 'alguém'}{' '}
                {timeAgo(meta.updatedAt)}
              </span>
            )}
            <span className="ml-auto">{saved && <span className="text-emerald-400">Salva</span>}</span>
            <button className="btn-primary py-1.5" onClick={() => void save()}>
              Salvar
            </button>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
    </Dialog>
  )
}
