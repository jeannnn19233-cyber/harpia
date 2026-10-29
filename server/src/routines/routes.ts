import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ROUTINE_TIMEZONE, type User } from '../../../shared/types.ts'
import { ensureAgentsEnabled } from '../agents/workspace.ts'
import { requireUser } from '../auth/guard.ts'
import type { AppContext } from '../context.ts'
import { HttpError, parse, parseId } from '../http/errors.ts'
import { nextRun, scheduleProblem } from './schedule.ts'
import { routineFolder, type RoutineRunner } from './runner.ts'
import { deleteRoutine, getRoutine, insertRoutine, listRuns, listUserRoutines, publicRoutine, updateRoutine, type StoredRoutine } from './store.ts'

// Cada pessoa pode ter até tantas rotinas: todas gastam a cota do Claude dela.
const MAX_ROUTINES = 30

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

const fields = {
  name: z.string().trim().min(1, 'Dê um nome à rotina.').max(60),
  prompt: z.string().trim().min(1, 'Escreva o que o agente deve fazer.').max(8000),
  schedule: z.string().trim().min(9).max(100),
  timezone: z.string().trim().refine(validTimezone, 'Fuso horário inválido.'),
  folder: z.enum(['routine', 'vault']),
  web: z.boolean(),
  model: z
    .string()
    .trim()
    .regex(/^[\w.:\-[\]/]{1,100}$/, 'Modelo inválido.')
    .nullable(),
  deliver: z.enum(['telegram', 'harpia']),
  continuity: z.boolean(),
  enabled: z.boolean()
}
const createSchema = z.object({
  ...fields,
  timezone: fields.timezone.default(ROUTINE_TIMEZONE),
  folder: fields.folder.default('routine'),
  web: fields.web.default(true),
  model: fields.model.default(null),
  deliver: fields.deliver.default('telegram'),
  continuity: fields.continuity.default(false),
  enabled: fields.enabled.default(true)
})
const updateSchema = z.object(fields).partial()
const previewSchema = z.object({ schedule: z.string().trim().min(1).max(100), timezone: fields.timezone.default(ROUTINE_TIMEZONE) })

export function registerRoutineRoutes(app: FastifyInstance, ctx: AppContext, runner: RoutineRunner): void {
  app.addHook('onReady', async () => runner.start())
  app.addHook('preClose', async () => runner.stop())

  // Rotinas são pessoais: as de outra pessoa respondem como se não existissem.
  function load(id: unknown, user: User): StoredRoutine {
    const routine = getRoutine(ctx.db, parseId(id))
    if (!routine || routine.userId !== user.id) throw new HttpError(404, 'Rotina não encontrada.')
    return routine
  }

  function checkSchedule(schedule: string, timezone: string): void {
    const problem = scheduleProblem(schedule, timezone)
    if (problem) throw new HttpError(400, problem)
  }

  function nameTaken(user: User, name: string, exceptId?: number): boolean {
    return listUserRoutines(ctx.db, user.id).some((routine) => routine.id !== exceptId && routine.name.toLowerCase() === name.toLowerCase())
  }

  const view = (routine: StoredRoutine) => ({ ...publicRoutine(routine), running: runner.isRunning(routine.id) })

  app.get('/api/routines', async (request) => {
    const user = requireUser(request)
    return { routines: listUserRoutines(ctx.db, user.id).map(view) }
  })

  // Próximos horários de uma expressão, para a tela mostrar antes de salvar.
  app.get('/api/routines/preview', async (request) => {
    requireUser(request)
    const { schedule, timezone } = parse(previewSchema, request.query)
    const problem = scheduleProblem(schedule, timezone)
    if (problem) return { problem, next: [] }
    const next: string[] = []
    let after = ctx.now()
    for (let i = 0; i < 3; i++) {
      const run = nextRun(schedule, timezone, after)
      if (!run) break
      next.push(run.toISOString())
      after = run
    }
    return { problem: null, next }
  })

  app.post('/api/routines', async (request) => {
    const user = requireUser(request)
    const input = parse(createSchema, request.body)
    ensureAgentsEnabled(ctx)
    checkSchedule(input.schedule, input.timezone)
    if (listUserRoutines(ctx.db, user.id).length >= MAX_ROUTINES) throw new HttpError(400, `Limite de ${MAX_ROUTINES} rotinas por pessoa.`)
    if (nameTaken(user, input.name)) throw new HttpError(409, 'Você já tem uma rotina com esse nome.')
    const now = ctx.now()
    const created = insertRoutine(
      ctx.db,
      user.id,
      {
        ...input,
        cwd: '',
        nextRunAt: input.enabled ? (nextRun(input.schedule, input.timezone, now)?.toISOString() ?? null) : null
      },
      now
    )
    const routine = updateRoutine(ctx.db, created.id, { cwd: routineFolder(created) }, now) as StoredRoutine
    runner.publishRoutine(routine)
    return { routine: view(routine) }
  })

  app.patch('/api/routines/:id', async (request) => {
    const user = requireUser(request)
    const routine = load((request.params as { id: string }).id, user)
    const input = parse(updateSchema, request.body)
    if (Object.values(input).every((value) => value === undefined)) throw new HttpError(400, 'Nada para alterar.')
    const schedule = input.schedule ?? routine.schedule
    const timezone = input.timezone ?? routine.timezone
    checkSchedule(schedule, timezone)
    if (input.name && nameTaken(user, input.name, routine.id)) throw new HttpError(409, 'Você já tem uma rotina com esse nome.')
    const now = ctx.now()
    const enabled = input.enabled ?? routine.enabled
    const retimed = input.schedule !== undefined || input.timezone !== undefined || input.enabled !== undefined
    const updated = updateRoutine(
      ctx.db,
      routine.id,
      {
        ...input,
        cwd: routineFolder({ id: routine.id, folder: input.folder ?? routine.folder }),
        ...(retimed ? { nextRunAt: enabled ? (nextRun(schedule, timezone, now)?.toISOString() ?? null) : null } : {}),
        // Religar a rotina zera as falhas e a espera pela cota.
        ...(input.enabled === true && !routine.enabled ? { failureStreak: 0, holdUntil: null } : {})
      },
      now
    ) as StoredRoutine
    runner.publishRoutine(updated)
    return { routine: view(updated) }
  })

  app.delete('/api/routines/:id', async (request) => {
    const user = requireUser(request)
    const routine = load((request.params as { id: string }).id, user)
    if (runner.isRunning(routine.id)) throw new HttpError(409, 'A rotina está rodando. Espere terminar para excluir.')
    deleteRoutine(ctx.db, routine.id)
    ctx.hub.broadcastWhere({ type: 'routine_removed', routineId: routine.id }, (userId) => userId === user.id)
    return { ok: true }
  })

  app.post('/api/routines/:id/run', async (request) => {
    const user = requireUser(request)
    const routine = load((request.params as { id: string }).id, user)
    ensureAgentsEnabled(ctx)
    const run = runner.runNow(routine)
    return { run }
  })

  app.get('/api/routines/:id/runs', async (request) => {
    const user = requireUser(request)
    const routine = load((request.params as { id: string }).id, user)
    return { runs: listRuns(ctx.db, routine.id) }
  })
}
