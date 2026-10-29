import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { User } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { transaction } from '../db/index.ts'
import { HttpError, parse } from '../http/errors.ts'
import { requireAdmin, requireUser } from './guard.ts'
import { createInvite, findOpenInvite, markInviteUsed } from './invites.ts'
import { hashPassword, hashToken, verifyPassword } from './passwords.ts'
import { createSession, deleteSession, SESSION_COOKIE } from './sessions.ts'
import {
  countUsers,
  emailInUse,
  findUserByGitHubLogin,
  getUserWithPassword,
  insertUser,
  listUsers,
  setCodexSuggestions,
  setGitHubLogin
} from './users.ts'

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, 'mínimo de 8 caracteres').max(200)
})

const setupSchema = accountSchema.extend({
  setupCode: z.string().max(200).optional()
})

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().max(200)
})

// Regras de nome de usuário do GitHub: letras, números e hífen, até 39 caracteres.
const profileSchema = z.object({
  githubLogin: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Usuário do GitHub inválido.'))
    .nullable()
    .optional(),
  codexSuggestions: z.boolean().optional()
})

const inviteSchema = z.object({
  role: z.enum(['admin', 'member']).default('member')
})

// Limite simples de tentativas de login por IP, em memória.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const loginAttempts = new Map<string, { count: number; resetAt: number }>()

  function startSession(reply: FastifyReply, user: User): void {
    const { token, expiresAt } = createSession(ctx.db, user.id, ctx.now())
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure,
      expires: expiresAt
    })
  }

  // Usado pelo Docker/Coolify para saber se o servidor está de pé.
  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/status', async () => ({
    needsSetup: countUsers(ctx.db) === 0,
    setupCodeRequired: ctx.config.setupCode !== null
  }))

  function checkSetupCode(code: string | undefined): void {
    const expected = ctx.config.setupCode
    if (expected === null) return
    const matches = timingSafeEqual(Buffer.from(hashToken(code ?? '')), Buffer.from(hashToken(expected)))
    if (!matches) throw new HttpError(403, 'Código de configuração incorreto.')
  }

  // Cria o primeiro usuário (administrador). Só funciona com o banco vazio.
  app.post('/api/setup', async (request, reply) => {
    const { setupCode, ...input } = parse(setupSchema, request.body)
    if (countUsers(ctx.db) > 0) throw new HttpError(409, 'O Harpia já foi configurado.')
    checkSetupCode(setupCode)
    const passwordHash = await hashPassword(input.password)
    const user = transaction(ctx.db, () => {
      if (countUsers(ctx.db) > 0) throw new HttpError(409, 'O Harpia já foi configurado.')
      return insertUser(ctx.db, { ...input, passwordHash, role: 'admin', now: ctx.now() })
    })
    startSession(reply, user)
    ctx.hub.broadcast({ type: 'user', user })
    return { user }
  })

  app.post('/api/login', async (request, reply) => {
    const ip = request.ip
    const now = Date.now()
    const attempt = loginAttempts.get(ip)
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Muitas tentativas. Espere 15 minutos e tente de novo.')
    }

    const input = parse(loginSchema, request.body)
    const found = getUserWithPassword(ctx.db, input.email)
    const valid = found ? await verifyPassword(input.password, found.passwordHash) : false
    if (!found || !valid) {
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS }
      current.count += 1
      loginAttempts.set(ip, current)
      throw new HttpError(401, 'E-mail ou senha incorretos.')
    }

    loginAttempts.delete(ip)
    startSession(reply, found.user)
    return { user: found.user }
  })

  app.post('/api/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) deleteSession(ctx.db, token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/me', async (request) => ({ user: requireUser(request) }))

  // Cada pessoa informa o próprio usuário do GitHub: os PRs dela são revisados no Claude dela.
  app.patch('/api/me', async (request) => {
    const user = requireUser(request)
    const { githubLogin, codexSuggestions } = parse(profileSchema, request.body)
    let updated = user
    if (githubLogin !== undefined) {
      const owner = githubLogin ? findUserByGitHubLogin(ctx.db, githubLogin) : null
      if (owner && owner.id !== user.id) throw new HttpError(409, `O usuário ${githubLogin} do GitHub já está ligado a ${owner.name}.`)
      updated = setGitHubLogin(ctx.db, user.id, githubLogin) as User
    }
    if (codexSuggestions !== undefined) updated = setCodexSuggestions(ctx.db, user.id, codexSuggestions) as User
    ctx.hub.broadcast({ type: 'user', user: updated })
    return { user: updated }
  })

  app.get('/api/users', async () => ({ users: listUsers(ctx.db) }))

  app.post('/api/invites', async (request) => {
    const admin = requireAdmin(request)
    const input = parse(inviteSchema, request.body ?? {})
    return { invite: createInvite(ctx.db, { role: input.role, createdBy: admin.id, now: ctx.now() }) }
  })

  app.get('/api/invites/:token', async (request) => {
    const { token } = request.params as { token: string }
    const invite = findOpenInvite(ctx.db, token, ctx.now())
    if (!invite) throw new HttpError(404, 'Convite inválido ou expirado.')
    return { invite: { role: invite.role, expiresAt: invite.expiresAt } }
  })

  app.post('/api/invites/:token/accept', async (request, reply) => {
    const { token } = request.params as { token: string }
    const input = parse(accountSchema, request.body)
    const passwordHash = await hashPassword(input.password)
    const user = transaction(ctx.db, () => {
      const invite = findOpenInvite(ctx.db, token, ctx.now())
      if (!invite) throw new HttpError(404, 'Convite inválido ou expirado.')
      if (emailInUse(ctx.db, input.email)) throw new HttpError(409, 'Já existe uma conta com esse e-mail.')
      const created = insertUser(ctx.db, { ...input, passwordHash, role: invite.role, now: ctx.now() })
      markInviteUsed(ctx.db, token, created.id, ctx.now())
      return created
    })
    startSession(reply, user)
    ctx.hub.broadcast({ type: 'user', user })
    return { user }
  })
}
