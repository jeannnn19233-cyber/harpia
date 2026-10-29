import { useState } from 'react'
import { TASK_STATUS_LABELS, TASK_STATUSES } from '../../../shared/types.ts'
import { api, type ImportSummary } from '../lib/api.ts'
import { Dialog } from './Dialogs.tsx'

// Importa um quadro de tarefas exportado (JSON com "tarefas"). Primeiro mostra o que vai fazer;
// só grava depois da confirmação. Reimportar atualiza só os cartões que mudaram na origem.
export function ImportDialog({ projectId, projectName, onClose }: { projectId: number; projectName: string; onClose: () => void }) {
  const [board, setBoard] = useState<Record<string, unknown> | null>(null)
  const [includeDone, setIncludeDone] = useState(false)
  const [fileName, setFileName] = useState('')
  const [plan, setPlan] = useState<ImportSummary | null>(null)
  const [done, setDone] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setPlan(null)
    setDone(null)
    setFileName(file.name)
    setBusy(true)
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      setBoard(parsed)
      setPlan((await api.importPreview(projectId, { ...parsed, incluirFeitas: includeDone })).plan)
    } catch (err) {
      setBoard(null)
      setError(err instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggleDone = async (value: boolean) => {
    setIncludeDone(value)
    if (!board) return
    setBusy(true)
    try {
      setPlan((await api.importPreview(projectId, { ...board, incluirFeitas: value })).plan)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      setDone((await api.importBoard(projectId, { ...board, incluirFeitas: includeDone })).plan)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Importar quadro de tarefas" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-400">
          Traz para <b>{projectName}</b> as tarefas de um quadro exportado em JSON (com a lista <code>tarefas</code>). Cada cartão vira uma task
          com o código dele no título; importar de novo atualiza só os cartões que mudaram no quadro de origem.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">Arquivo do quadro (.json)</span>
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={includeDone} disabled={busy || !!done} onChange={(e) => void toggleDone(e.target.checked)} />
          Incluir as tarefas já feitas (entram direto em Feito)
        </label>
        {busy && <p className="text-zinc-400">Lendo {fileName}…</p>}
        {error && <p className="text-rose-300">{error}</p>}
        {plan && !done && (
          <div className="space-y-2 rounded-lg border border-zinc-800 px-4 py-3">
            <p>
              <b>{plan.create}</b> tasks novas · <b>{plan.update}</b> atualizadas · {plan.unchanged} sem mudança
            </p>
            <p className="text-xs text-zinc-400">
              {TASK_STATUSES.filter((status) => plan.byStatus[status] > 0)
                .map((status) => `${TASK_STATUS_LABELS[status]}: ${plan.byStatus[status]}`)
                .join(' · ')}
              . Bloqueadas entram no Backlog, com o aviso no topo da descrição.
              {plan.skippedDone > 0 && ` ${plan.skippedDone} feitas ficam de fora.`}
            </p>
            {plan.unknownOwners.length > 0 && (
              <p className="text-xs text-amber-300">
                Sem conta no Harpia: {plan.unknownOwners.join(', ')}. As tasks dessas pessoas ficam sem responsável, com o nome na descrição;
                depois de convidar, importe de novo para atribuir.
              </p>
            )}
            {plan.invalid.length > 0 && (
              <p className="text-xs text-rose-300">
                Ficam de fora: {plan.invalid.map((item) => `${item.id} (${item.reason})`).join('; ')}.
              </p>
            )}
            <button className="btn-primary" disabled={busy || plan.create + plan.update === 0} onClick={() => void run()}>
              {plan.create + plan.update === 0 ? 'Nada para importar' : `Importar ${plan.create + plan.update} tasks`}
            </button>
          </div>
        )}
        {done && (
          <p className="rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-4 py-3 text-emerald-200">
            Pronto: {done.create} tasks criadas e {done.update} atualizadas.
          </p>
        )}
      </div>
    </Dialog>
  )
}
