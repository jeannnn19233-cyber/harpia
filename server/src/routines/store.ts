import type { Routine, RoutineDeliver, RoutineFolder, RoutineRun, RoutineRunStatus } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

interface RoutineRow {
  id: number
  user_id: number
  name: string
  prompt: string
  schedule: string
  timezone: string
  folder: RoutineFolder
  web: number
  model: string | null
  deliver: RoutineDeliver
  continuity: number
  enabled: number
  cwd: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: RoutineRunStatus | null
  last_error: string | null
  failure_streak: number
  hold_until: string | null
  created_at: string
  updated_at: string
}

interface RunRow {
  id: number
  routine_id: number
  scheduled_for: string
  trigger: 'schedule' | 'manual'
  status: RoutineRunStatus
  chat_id: number | null
  output: string | null
  error: string | null
  delivered: number
  started_at: string
  finished_at: string | null
}

export interface StoredRoutine extends Routine {
  cwd: string
}

function toRoutine(row: RoutineRow): StoredRoutine {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    timezone: row.timezone,
    folder: row.folder,
    web: row.web === 1,
    model: row.model,
    deliver: row.deliver,
    continuity: row.continuity === 1,
    enabled: row.enabled === 1,
    cwd: row.cwd,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    failureStreak: row.failure_streak,
    holdUntil: row.hold_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function publicRoutine(routine: StoredRoutine): Routine {
  const { cwd: _cwd, ...rest } = routine
  return rest
}

function toRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    scheduledFor: row.scheduled_for,
    trigger: row.trigger,
    status: row.status,
    chatId: row.chat_id,
    output: row.output,
    error: row.error,
    delivered: row.delivered === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

export function getRoutine(db: Db, id: number): StoredRoutine | null {
  const row = db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
  return row ? toRoutine(row) : null
}

export function listUserRoutines(db: Db, userId: number): StoredRoutine[] {
  const rows = db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId) as unknown as RoutineRow[]
  return rows.map(toRoutine)
}

export function findRoutineByName(db: Db, userId: number, name: string): StoredRoutine[] {
  const rows = db
    .prepare('SELECT * FROM routines WHERE user_id = ? AND name LIKE ? ORDER BY name')
    .all(userId, `%${name.replace(/[%_]/g, '')}%`) as unknown as RoutineRow[]
  const list = rows.map(toRoutine)
  const exact = list.filter((routine) => routine.name.toLowerCase() === name.toLowerCase())
  return exact.length > 0 ? exact : list
}

// Rotinas ligadas cujo horário chegou (e que não estão esperando a cota voltar).
export function listDueRoutines(db: Db, now: Date): StoredRoutine[] {
  const stamp = now.toISOString()
  const rows = db
    .prepare(
      `SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       AND (hold_until IS NULL OR hold_until <= ?) ORDER BY next_run_at`
    )
    .all(stamp, stamp) as unknown as RoutineRow[]
  return rows.map(toRoutine)
}

export interface RoutineFields {
  name: string
  prompt: string
  schedule: string
  timezone: string
  folder: RoutineFolder
  web: boolean
  model: string | null
  deliver: RoutineDeliver
  continuity: boolean
  enabled: boolean
  cwd: string
  nextRunAt: string | null
}

export function insertRoutine(db: Db, userId: number, fields: RoutineFields, now: Date): StoredRoutine {
  const stamp = now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO routines (user_id, name, prompt, schedule, timezone, folder, web, model, deliver, continuity, enabled, cwd,
                             next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      fields.name,
      fields.prompt,
      fields.schedule,
      fields.timezone,
      fields.folder,
      fields.web ? 1 : 0,
      fields.model,
      fields.deliver,
      fields.continuity ? 1 : 0,
      fields.enabled ? 1 : 0,
      fields.cwd,
      fields.nextRunAt,
      stamp,
      stamp
    )
  return getRoutine(db, Number(result.lastInsertRowid)) as StoredRoutine
}

const COLUMNS: Record<string, string> = {
  name: 'name',
  prompt: 'prompt',
  schedule: 'schedule',
  timezone: 'timezone',
  folder: 'folder',
  web: 'web',
  model: 'model',
  deliver: 'deliver',
  continuity: 'continuity',
  enabled: 'enabled',
  cwd: 'cwd',
  nextRunAt: 'next_run_at',
  lastRunAt: 'last_run_at',
  lastStatus: 'last_status',
  lastError: 'last_error',
  failureStreak: 'failure_streak',
  holdUntil: 'hold_until'
}

export function updateRoutine(
  db: Db,
  id: number,
  fields: Partial<RoutineFields & { lastRunAt: string | null; lastStatus: RoutineRunStatus | null; lastError: string | null; failureStreak: number; holdUntil: string | null }>,
  now: Date
): StoredRoutine | null {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${COLUMNS[key]} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  sets.push('updated_at = ?')
  values.push(now.toISOString())
  db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getRoutine(db, id)
}

// Avança o próximo horário só se ninguém avançou antes (reserva do horário). true = esta chamada reservou.
export function claimSlot(db: Db, id: number, slot: string, next: string | null): boolean {
  return db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ? AND next_run_at = ?').run(next, id, slot).changes > 0
}

export function deleteRoutine(db: Db, id: number): void {
  db.prepare('DELETE FROM routines WHERE id = ?').run(id)
}

export function insertRun(
  db: Db,
  input: { routineId: number; scheduledFor: string; trigger: 'schedule' | 'manual'; status: RoutineRunStatus; error?: string | null; now: Date }
): RoutineRun {
  const result = db
    .prepare(
      `INSERT INTO routine_runs (routine_id, scheduled_for, trigger, status, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.routineId,
      input.scheduledFor,
      input.trigger,
      input.status,
      input.error ?? null,
      input.now.toISOString(),
      input.status === 'running' ? null : input.now.toISOString()
    )
  return getRun(db, Number(result.lastInsertRowid)) as RoutineRun
}

export function getRun(db: Db, id: number): RoutineRun | null {
  const row = db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(id) as RunRow | undefined
  return row ? toRun(row) : null
}

export function updateRun(
  db: Db,
  id: number,
  fields: Partial<{ status: RoutineRunStatus; chatId: number; output: string | null; error: string | null; delivered: boolean; finishedAt: string }>
): RoutineRun | null {
  const columns: Record<string, string> = {
    status: 'status',
    chatId: 'chat_id',
    output: 'output',
    error: 'error',
    delivered: 'delivered',
    finishedAt: 'finished_at'
  }
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${columns[key]} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length > 0) db.prepare(`UPDATE routine_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getRun(db, id)
}

export function listRuns(db: Db, routineId: number, limit = 30): RoutineRun[] {
  const rows = db
    .prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?')
    .all(routineId, limit) as unknown as RunRow[]
  return rows.map(toRun)
}

// Última saída entregue (ou silenciosa) antes desta execução, para a continuidade.
export function previousOutput(db: Db, routineId: number, beforeRunId: number): { output: string; startedAt: string } | null {
  const row = db
    .prepare(
      `SELECT output, started_at FROM routine_runs WHERE routine_id = ? AND id < ? AND status = 'ok' AND output IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(routineId, beforeRunId) as { output: string; started_at: string } | undefined
  return row ? { output: row.output, startedAt: row.started_at } : null
}

// Execuções que estavam rodando quando o servidor caiu: nunca são repetidas sozinhas.
export function interruptRunningRuns(db: Db, now: Date): number {
  return Number(db
    .prepare(
      `UPDATE routine_runs SET status = 'interrupted', error = 'O servidor reiniciou durante a execução.', finished_at = ?
       WHERE status = 'running'`
    )
    .run(now.toISOString()).changes)
}
