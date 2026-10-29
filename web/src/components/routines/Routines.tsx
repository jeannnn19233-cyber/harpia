import { useEffect, useMemo, useState } from 'react'
import { cronToPreset, describeSchedule, presetToCron, type SchedulePreset } from '../../../../shared/schedule.ts'
import { ROUTINE_TIMEZONE, type Routine, type RoutineRun } from '../../../../shared/types.ts'
import { api, type RoutineInput } from '../../lib/api.ts'
import { fullDate, timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Dialog } from '../Dialogs.tsx'
import { RichText } from '../task/RichText.tsx'
import { ChatView } from '../task/ChatView.tsx'
import { ModelPicker } from '../task/ModelSelect.tsx'

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

// Pontos de partida prontos, como os "blueprints" do Hermes: ninguém precisa escrever cron.
const TEMPLATES: { label: string; input: Partial<RoutineInput> }[] = [
  {
    label: 'Resumo da manhã',
    input: {
      name: 'Resumo da manhã',
      schedule: '30 7 * * 1-5',
      folder: 'routine',
      web: true,
      continuity: true,
      prompt:
        'Pesquise as notícias mais importantes das últimas 24 horas sobre: inteligência artificial, desenvolvimento de software e o mercado em que a Clarumi atua.\n\n' +
        'Mande no máximo 7 itens, cada um com uma frase sobre por que importa para nós e o link da fonte. Comece pelo mais relevante. ' +
        'Se não houver nada realmente novo, responda [SILENT].'
    }
  },
  {
    label: 'Diário do cofre',
    input: {
      name: 'Diário do cofre',
      schedule: '0 21 * * *',
      folder: 'vault',
      web: false,
      continuity: false,
      prompt:
        'Crie (ou complete) a nota de hoje em diario/AAAA-MM-DD.md com um resumo do que entrou no cofre hoje: notas novas, ideias, links e decisões, ' +
        'cada item com [[wikilink]] para a página correspondente. Depois me mande um resumo de 3 a 5 linhas. Se nada entrou hoje, responda [SILENT].'
    }
  },
  {
    label: 'Revisão semanal do cofre',
    input: {
      name: 'Revisão semanal do cofre',
      schedule: '0 18 * * 5',
      folder: 'vault',
      web: false,
      continuity: true,
      prompt:
        'Faça a manutenção do cofre: encontre páginas órfãs (sem links chegando), links [[quebrados]], notas duplicadas sobre o mesmo assunto, ' +
        'itens em raw/ que ainda não viraram página e tags fora do padrão do SCHEMA.md. Corrija o que for seguro (até 10 páginas) e me mande a lista do que ' +
        'corrigiu e do que precisa da minha decisão.'
    }
  }
]

const STATUS: Record<RoutineRun['status'], { label: string; className: string }> = {
  running: { label: 'rodando', className: 'bg-sky-500/15 text-sky-300' },
  ok: { label: 'entregue', className: 'bg-emerald-500/15 text-emerald-300' },
  silent: { label: 'nada novo', className: 'bg-zinc-700/50 text-zinc-300' },
  failed: { label: 'falhou', className: 'bg-rose-500/15 text-rose-300' },
  skipped: { label: 'pulada', className: 'bg-amber-500/15 text-amber-300' },
  interrupted: { label: 'interrompida', className: 'bg-amber-500/15 text-amber-300' }
}

function emptyInput(): RoutineInput {
  return {
    name: '',
    prompt: '',
    schedule: '0 9 * * 1-5',
    timezone: ROUTINE_TIMEZONE,
    folder: 'routine',
    web: true,
    model: null,
    deliver: 'telegram',
    continuity: false,
    enabled: true
  }
}

function toInput(routine: Routine): RoutineInput {
  const { name, prompt, schedule, timezone, folder, web, model, deliver, continuity, enabled } = routine
  return { name, prompt, schedule, timezone, folder, web, model, deliver, continuity, enabled }
}

// Data e hora no fuso da rotina, não no do navegador.
function inZone(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' })
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// Escolha do horário sem cron: "todo dia", "dias úteis", "toda semana", "a cada N horas" ou avançado.
function SchedulePicker({ value, timezone, onChange }: { value: string; timezone: string; onChange: (schedule: string) => void }) {
  const preset = cronToPreset(value)
  const [preview, setPreview] = useState<{ problem: string | null; next: string[] } | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .previewSchedule(value, timezone)
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(timer)
  }, [value, timezone])

  const set = (next: SchedulePreset) => onChange(presetToCron(next))
  const hour = 'hour' in preset ? preset.hour : 9
  const minute = 'minute' in preset ? preset.minute : 0
  const timeInput = (
    <input
      type="time"
      className="input w-32"
      value={`${pad(hour)}:${pad(minute)}`}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number)
        if (Number.isNaN(h) || Number.isNaN(m)) return
        if (preset.kind === 'daily' || preset.kind === 'weekdays') set({ ...preset, hour: h, minute: m })
        if (preset.kind === 'weekly') set({ ...preset, hour: h, minute: m })
      }}
    />
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          value={preset.kind}
          onChange={(e) => {
            const kind = e.target.value as SchedulePreset['kind']
            if (kind === 'daily' || kind === 'weekdays') set({ kind, hour, minute })
            else if (kind === 'weekly') set({ kind, weekday: 1, hour, minute })
            else if (kind === 'hours') set({ kind, every: 2 })
            else if (kind === 'minutes') set({ kind, every: 30 })
            else set({ kind: 'cron', expression: value })
          }}
        >
          <option value="daily">Todo dia</option>
          <option value="weekdays">Dias úteis</option>
          <option value="weekly">Toda semana</option>
          <option value="hours">A cada N horas</option>
          <option value="minutes">A cada N minutos</option>
          <option value="cron">Avançado (cron)</option>
        </select>
        {preset.kind === 'weekly' && (
          <select className="input w-auto" value={preset.weekday} onChange={(e) => set({ ...preset, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        )}
        {(preset.kind === 'daily' || preset.kind === 'weekdays' || preset.kind === 'weekly') && (
          <>
            <span className="text-sm text-zinc-400">às</span>
            {timeInput}
          </>
        )}
        {preset.kind === 'hours' && (
          <select className="input w-auto" value={preset.every} onChange={(e) => set({ kind: 'hours', every: Number(e.target.value) })}>
            {[1, 2, 3, 4, 6, 8, 12].map((every) => (
              <option key={every} value={every}>
                {every === 1 ? '1 hora' : `${every} horas`}
              </option>
            ))}
          </select>
        )}
        {preset.kind === 'minutes' && (
          <select className="input w-auto" value={preset.every} onChange={(e) => set({ kind: 'minutes', every: Number(e.target.value) })}>
            {[15, 20, 30].map((every) => (
              <option key={every} value={every}>
                {every} minutos
              </option>
            ))}
          </select>
        )}
        {preset.kind === 'cron' && (
          <input
            className="input w-48 font-mono"
            value={preset.expression}
            placeholder="0 9 * * 1-5"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
      <p className={`text-xs ${preview?.problem ? 'text-rose-300' : 'text-zinc-500'}`}>
        {preview?.problem ??
          (preview && preview.next.length > 0
            ? `Próximas: ${preview.next.map((iso) => inZone(iso, timezone)).join(' · ')}${timezone === ROUTINE_TIMEZONE ? ' (horário de Brasília)' : ` (${timezone})`}`
            : ' ')}
      </p>
    </div>
  )
}

function RoutineForm({ routine, onSaved, onCancel }: { routine: Routine | null; onSaved: (routine: Routine) => void; onCancel: () => void }) {
  const [input, setInput] = useState<RoutineInput>(routine ? toInput(routine) : emptyInput())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (fields: Partial<RoutineInput>) => setInput((current) => ({ ...current, ...fields }))

  const save = async () => {
    setSaving(true)
    try {
      const result = routine ? await api.updateRoutine(routine.id, input) : await api.createRoutine(input)
      setError(null)
      onSaved(result.routine)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {!routine && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">Começar de um modelo:</span>
          {TEMPLATES.map((template) => (
            <button key={template.label} className="btn-outline px-2 py-1 text-xs" onClick={() => change(template.input)}>
              {template.label}
            </button>
          ))}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-zinc-400">Nome</span>
        <input className="input" value={input.name} maxLength={60} onChange={(e) => change({ name: e.target.value })} placeholder="Resumo da manhã" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-400">O que o agente deve fazer</span>
        <textarea
          className="input min-h-36 resize-y"
          value={input.prompt}
          onChange={(e) => change({ prompt: e.target.value })}
          placeholder="Ex.: pesquise as notícias de IA das últimas 24 horas e me mande os 5 itens mais importantes, com links."
        />
      </label>
      <div className="space-y-1">
        <span className="text-xs text-zinc-400">Quando</span>
        <SchedulePicker value={input.schedule} timezone={input.timezone} onChange={(schedule) => change({ schedule })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Onde o agente trabalha</span>
          <select className="input" value={input.folder} onChange={(e) => change({ folder: e.target.value as RoutineInput['folder'] })}>
            <option value="routine">Numa pasta só desta rotina</option>
            <option value="vault">No meu cofre (Obsidian)</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Entrega</span>
          <select className="input" value={input.deliver} onChange={(e) => change({ deliver: e.target.value as RoutineInput['deliver'] })}>
            <option value="telegram">No meu Telegram</option>
            <option value="harpia">Só no Harpia</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Modelo (sua conta do Claude)</span>
          <ModelPicker provider="claude" value={input.model} onChange={(model) => change({ model })} className="input" />
        </label>
        <div className="space-y-2 pt-5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={input.web} onChange={(e) => change({ web: e.target.checked })} />
            Pode pesquisar e ler páginas na web
          </label>
          <label className="flex items-center gap-2" title="A resposta anterior entra no contexto, para não repetir o que já foi dito">
            <input type="checkbox" checked={input.continuity} onChange={(e) => change({ continuity: e.target.checked })} />
            Lembrar da execução anterior
          </label>
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Sem ninguém olhando, o agente não tem terminal: só lê e escreve arquivos na pasta escolhida{input.web ? ' e usa a web' : ''}. Se não houver nada
        novo, ele fica em silêncio.
      </p>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving || !input.name.trim() || !input.prompt.trim()} onClick={() => void save()}>
          {saving ? 'Salvando…' : routine ? 'Salvar' : 'Criar rotina'}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

function RunList({ routine, onOpenChat }: { routine: Routine; onOpenChat: (chatId: number) => void }) {
  const runs = useHarpia((state) => state.routineRuns[routine.id])
  const setRoutineRuns = useHarpia((state) => state.setRoutineRuns)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    api
      .routineRuns(routine.id)
      .then(({ runs }) => setRoutineRuns(routine.id, runs))
      .catch(() => undefined)
  }, [routine.id, setRoutineRuns])

  if (!runs) return <p className="text-sm text-zinc-500">Carregando…</p>
  if (runs.length === 0) return <p className="text-sm text-zinc-500">Ainda não rodou.</p>
  return (
    <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
      {runs.map((run) => {
        const status = STATUS[run.status]
        return (
          <li key={run.id} className="px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${status.className}`}>{status.label}</span>
              <span className="text-zinc-300" title={fullDate(run.startedAt)}>
                {timeAgo(run.startedAt)}
              </span>
              {run.trigger === 'manual' && <span className="text-xs text-zinc-500">rodada na mão</span>}
              {run.status === 'ok' && (
                <span className="text-xs text-zinc-500">
                  {run.delivered ? '· no Telegram' : routine.deliver === 'telegram' ? '· Telegram não vinculado' : '· só no Harpia'}
                </span>
              )}
              <span className="ml-auto flex gap-1">
                {run.output && (
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setOpen(open === run.id ? null : run.id)}>
                    {open === run.id ? 'ocultar' : 'resultado'}
                  </button>
                )}
                {run.chatId && (
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => onOpenChat(run.chatId!)}>
                    conversa
                  </button>
                )}
              </span>
            </div>
            {run.error && <p className="mt-1 text-xs text-rose-300">{run.error}</p>}
            {open === run.id && run.output && (
              <div className="mt-2 rounded-md bg-zinc-900 px-3 py-2 text-zinc-200">
                <RichText text={run.output} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function RoutineDetail({ routine, onEdit }: { routine: Routine; onEdit: () => void }) {
  const runs = useHarpia((state) => state.routineRuns[routine.id])
  const [error, setError] = useState<string | null>(null)
  const [chatId, setChatId] = useState<number | null>(null)
  const running = runs?.some((run) => run.status === 'running') ?? false

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{routine.name}</h2>
          <p className="text-sm text-zinc-400">
            {describeSchedule(routine.schedule)} · {routine.folder === 'vault' ? 'no cofre' : 'pasta própria'}
            {routine.web ? ' · com web' : ''} · {routine.deliver === 'telegram' ? 'entrega no Telegram' : 'só no Harpia'}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {!routine.enabled
              ? 'Pausada'
              : routine.holdUntil
                ? `Esperando a cota do Claude voltar (${inZone(routine.holdUntil, routine.timezone)})`
                : routine.nextRunAt
                  ? `Próxima: ${inZone(routine.nextRunAt, routine.timezone)}`
                  : ''}
            {routine.failureStreak > 0 && ` · ${routine.failureStreak} falha(s) seguida(s)`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary py-1.5" disabled={running} onClick={() => void run(() => api.runRoutine(routine.id))}>
            {running ? 'Rodando…' : 'Rodar agora'}
          </button>
          <button className="btn-outline py-1.5" onClick={() => void run(() => api.updateRoutine(routine.id, { enabled: !routine.enabled }))}>
            {routine.enabled ? 'Pausar' : 'Retomar'}
          </button>
          <button className="btn-ghost py-1.5" onClick={onEdit}>
            Editar
          </button>
          <button
            className="btn-ghost py-1.5 text-rose-300"
            onClick={() => confirm(`Excluir a rotina "${routine.name}"?`) && void run(() => api.deleteRoutine(routine.id))}
          >
            Excluir
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      <section className="space-y-1">
        <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Pedido</p>
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-300">{routine.prompt}</p>
      </section>
      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Histórico</p>
        <RunList routine={routine} onOpenChat={setChatId} />
      </section>
      {chatId && (
        <Dialog title="Conversa da execução" wide onClose={() => setChatId(null)}>
          <div className="flex h-[70vh] flex-col">
            <ChatView chatId={chatId} />
          </div>
        </Dialog>
      )}
    </div>
  )
}

// Rotinas (cron): o agente de cada pessoa roda sozinho num horário e entrega no Telegram.
export function Routines() {
  const { agentsStatus, setRoutines, upsertRoutine } = useHarpia()
  const all = useHarpia((state) => state.routines)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .routines()
      .then(({ routines }) => setRoutines(routines))
      .catch((err: Error) => setError(err.message))
  }, [setRoutines])

  const routines = useMemo(() => Object.values(all).sort((a, b) => a.name.localeCompare(b.name)), [all])
  const selected = routines.find((routine) => routine.id === selectedId) ?? routines[0] ?? null
  const disabledReason = agentsStatus && !agentsStatus.enabled ? agentsStatus.reason : null

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
      <nav className="flex min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 p-3">
          {disabledReason ? (
            <p className="text-xs text-zinc-500">{disabledReason}</p>
          ) : (
            <button className="btn-outline w-full py-1.5 text-sm" onClick={() => setEditing('new')}>
              + Nova rotina
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {routines.length === 0 && <p className="px-2 py-2 text-xs text-zinc-500">Nenhuma rotina ainda.</p>}
          {routines.map((routine) => (
            <button
              key={routine.id}
              onClick={() => {
                setSelectedId(routine.id)
                setEditing(null)
              }}
              className={`w-full rounded-lg px-2 py-2 text-left ${selected?.id === routine.id && editing !== 'new' ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
            >
              <p className="flex items-center gap-2 truncate text-sm">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    !routine.enabled ? 'bg-zinc-600' : routine.lastStatus === 'failed' ? 'bg-rose-400' : 'bg-emerald-400'
                  }`}
                />
                {routine.name}
              </p>
              <p className="truncate pl-3.5 text-xs text-zinc-500">
                {routine.enabled ? describeSchedule(routine.schedule) : 'pausada'}
              </p>
            </button>
          ))}
        </div>
      </nav>
      <main className="min-h-0 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          {error && <p className="mb-3 text-sm text-rose-300">{error}</p>}
          {editing === 'new' ? (
            <>
              <h2 className="mb-4 text-lg font-semibold">Nova rotina</h2>
              <RoutineForm
                routine={null}
                onCancel={() => setEditing(null)}
                onSaved={(routine) => {
                  upsertRoutine(routine)
                  setSelectedId(routine.id)
                  setEditing(null)
                }}
              />
            </>
          ) : selected && editing === selected.id ? (
            <>
              <h2 className="mb-4 text-lg font-semibold">Editar rotina</h2>
              <RoutineForm
                routine={selected}
                onCancel={() => setEditing(null)}
                onSaved={(routine) => {
                  upsertRoutine(routine)
                  setEditing(null)
                }}
              />
            </>
          ) : selected ? (
            <RoutineDetail key={selected.id} routine={selected} onEdit={() => setEditing(selected.id)} />
          ) : (
            <div className="py-16 text-center text-sm text-zinc-500">
              <p className="mb-1 text-base text-zinc-300">Seu agente trabalhando sozinho, no horário que você escolher.</p>
              <p>
                Ex.: um resumo de notícias toda manhã no Telegram, ou organizar o seu cofre no fim do dia. Cada rotina roda no seu Claude, numa
                conversa nova, sem terminal.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
