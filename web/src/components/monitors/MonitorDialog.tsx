import { useEffect, useState } from 'react'
import type { HealthCheck } from '../../../../shared/types.ts'
import { api } from '../../lib/api.ts'
import { fullDate, timeAgo } from '../../lib/format.ts'
import { useHarpia } from '../../lib/store.ts'
import { Dialog } from '../Dialogs.tsx'
import { RichText } from '../task/RichText.tsx'

const DEPLOY_STATUS: Record<string, string> = {
  finished: 'concluído',
  failed: 'falhou',
  in_progress: 'em andamento',
  queued: 'na fila',
  'cancelled-by-user': 'cancelado'
}

const TIMEZONES = ['America/Sao_Paulo', 'UTC', 'America/Manaus', 'America/Recife', 'Europe/Lisbon']

// "campo=valor, campo=valor" ↔ { campo: valor }
function expectText(expect: Record<string, string>): string {
  return Object.entries(expect)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}
function parseExpect(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(',')
      .map((part) => part.split('=').map((piece) => piece.trim()))
      .filter((pair) => pair.length === 2 && pair[0])
  )
}

// Vigias do projeto no Coolify (deploy da branch principal, tarefas agendadas e URLs de saúde),
// como os vigias do Hermes: só leitura, sem IA, avisa no Telegram só quando algo muda.
export function MonitorDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const { users, setMonitor } = useHarpia()
  const monitor = useHarpia((state) => state.monitors[projectId])
  const events = useHarpia((state) => state.monitorEvents[projectId] ?? [])
  const [configured, setConfigured] = useState(true)
  const [apps, setApps] = useState<{ uuid: string; name: string }[]>([])
  const [form, setForm] = useState<{ app: string; checks: { url: string; expect: string }[]; timezone: string; notify: number[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .monitor(projectId)
      .then((result) => {
        setMonitor(result.monitor, result.events)
        setConfigured(result.coolifyConfigured)
        setForm({
          app: result.monitor.coolifyAppUuid,
          checks: result.monitor.healthChecks.map((check) => ({ url: check.url, expect: expectText(check.expect) })),
          timezone: result.monitor.timezone,
          notify: result.monitor.notifyUserIds
        })
        if (result.coolifyConfigured) {
          api
            .monitorApplications()
            .then((list) => setApps(list.applications))
            .catch((err: Error) => setError(err.message))
        }
      })
      .catch((err: Error) => setError(err.message))
  }, [projectId, setMonitor])

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

  const save = (enabled: boolean) =>
    run(async () => {
      if (!form) return
      const healthChecks: HealthCheck[] = form.checks.filter((check) => check.url.trim()).map((check) => ({ url: check.url.trim(), expect: parseExpect(check.expect) }))
      const { monitor: saved } = await api.saveMonitor(projectId, {
        enabled,
        coolifyAppUuid: form.app,
        healthChecks,
        timezone: form.timezone,
        notifyUserIds: form.notify
      })
      setMonitor(saved)
      if (enabled) {
        const result = await api.checkMonitor(projectId)
        setMonitor(result.monitor, result.events)
      }
    })

  const problems = monitor?.panorama.filter((item) => item.problem) ?? []

  return (
    <Dialog title="Vigias do deploy" wide onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-400">
          A cada 5 minutos o Harpia olha no Coolify o deploy da branch principal (terminou, falhou, preso há mais de 20 min, merge sem
          deploy), o estado da aplicação, as tarefas agendadas (falhou, desligada, deixou de rodar no horário) e as URLs de saúde. Só lê:
          nunca reinicia, nunca refaz deploy, nunca roda uma tarefa. Avisa no Telegram só quando algo muda; a primeira volta manda o
          panorama inteiro.
        </p>
        {!configured && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-amber-200">
            O servidor ainda não tem acesso ao Coolify. Um administrador precisa criar um token <b>só de leitura</b> no Coolify e colocar
            HARPIA_COOLIFY_URL e HARPIA_COOLIFY_TOKEN nas variáveis do Harpia (veja docs/COOLIFY.md).
          </p>
        )}
        {monitor?.enabled && (
          <div className="rounded-lg border border-zinc-800">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${problems.length ? 'bg-rose-400' : 'bg-emerald-400'}`} />
              <span className="font-medium">{problems.length ? `${problems.length} problema(s)` : 'Tudo normal'}</span>
              {monitor.checkedAt && <span className="text-xs text-zinc-500">conferido {timeAgo(monitor.checkedAt)}</span>}
              {monitor.lastDeploy && (
                <span className="text-xs text-zinc-500">
                  · último deploy #{monitor.lastDeploy.id} {DEPLOY_STATUS[monitor.lastDeploy.status] ?? monitor.lastDeploy.status} ({(monitor.lastDeploy.commit ?? '').slice(0, 7)})
                </span>
              )}
              <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" disabled={busy} onClick={() => void run(async () => {
                const result = await api.checkMonitor(projectId)
                setMonitor(result.monitor, result.events)
              })}>
                Conferir agora
              </button>
            </div>
            <ul className="divide-y divide-zinc-800">
              {monitor.panorama.map((item) => (
                <li key={item.key} className="flex gap-2 px-3 py-1.5 text-xs">
                  <span>{item.problem ? '🔴' : '✅'}</span>
                  <span className="text-zinc-300">{item.name}</span>
                  <span className={item.problem ? 'text-rose-300' : 'text-zinc-500'}>{item.problem ?? 'normal'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {form && (
          <div className="space-y-3 rounded-lg border border-zinc-800 px-4 py-3">
            <label className="block text-xs text-zinc-400">
              Aplicação no Coolify
              <select className="input mt-1" value={form.app} onChange={(e) => setForm({ ...form, app: e.target.value })} disabled={!configured}>
                <option value="">Escolha…</option>
                {apps.map((app) => (
                  <option key={app.uuid} value={app.uuid}>
                    {app.name}
                  </option>
                ))}
                {form.app && !apps.some((app) => app.uuid === form.app) && <option value={form.app}>{form.app}</option>}
              </select>
            </label>
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">URLs de saúde (GET; esperado HTTP 200 e, se quiser, campos no JSON como status=ok, banco=ok)</p>
              {form.checks.map((check, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className="input"
                    placeholder="https://www.exemplo.com/api/health/ready"
                    value={check.url}
                    onChange={(e) => setForm({ ...form, checks: form.checks.map((item, j) => (j === i ? { ...item, url: e.target.value } : item)) })}
                  />
                  <input
                    className="input max-w-56"
                    placeholder="status=ok, banco=ok"
                    value={check.expect}
                    onChange={(e) => setForm({ ...form, checks: form.checks.map((item, j) => (j === i ? { ...item, expect: e.target.value } : item)) })}
                  />
                  <button className="btn-ghost px-2" onClick={() => setForm({ ...form, checks: form.checks.filter((_, j) => j !== i) })} aria-label="Tirar URL">
                    ×
                  </button>
                </div>
              ))}
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setForm({ ...form, checks: [...form.checks, { url: '', expect: '' }] })}>
                + URL de saúde
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-zinc-400">
                Fuso dos horários nos avisos e das agendas do Coolify
                <select className="input mt-1" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                  {[...new Set([form.timezone, ...TIMEZONES])].map((zone) => (
                    <option key={zone}>{zone}</option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-zinc-400">
                Quem recebe os avisos no Telegram (ninguém marcado = administradores)
                <div className="mt-1 flex flex-wrap gap-3">
                  {Object.values(users).map((user) => (
                    <label key={user.id} className="flex items-center gap-1 text-zinc-300">
                      <input
                        type="checkbox"
                        checked={form.notify.includes(user.id)}
                        onChange={(e) =>
                          setForm({ ...form, notify: e.target.checked ? [...form.notify, user.id] : form.notify.filter((id) => id !== user.id) })
                        }
                      />
                      {user.name.split(' ')[0]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary py-1.5" disabled={busy || !form.app} onClick={() => void save(true)}>
                {monitor?.enabled ? 'Salvar' : 'Ligar os vigias'}
              </button>
              {monitor?.enabled && (
                <button className="btn-ghost py-1.5" disabled={busy} onClick={() => void save(false)}>
                  Desligar
                </button>
              )}
            </div>
          </div>
        )}
        {error && <p className="text-rose-300">{error}</p>}
        {events.length > 0 && (
          <div>
            <p className="mb-2 font-medium">Últimos avisos</p>
            <ul className="space-y-2">
              {events.map((event) => (
                <li key={event.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                  <p className="mb-1 text-zinc-500" title={fullDate(event.createdAt)}>
                    {timeAgo(event.createdAt)}
                  </p>
                  <RichText text={event.text} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  )
}
