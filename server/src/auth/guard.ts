import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { User } from '../../../shared/types.ts'
import type { AppContext } from '../context.ts'
import { HttpError } from '../http/errors.ts'
import { SESSION_COOKIE, userForSession } from './sessions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null
  }
}

// Rotas da API que funcionam sem login.
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/status',
  'POST /api/setup',
  'POST /api/login',
  'POST /api/logout',
  'GET /api/invites/:token',
  'POST /api/invites/:token/accept'
])

export function registerAuthGuard(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE]
    request.user = token ? userForSession(ctx.db, token, ctx.now()) : null

    if (!request.url.startsWith('/api/')) return
    rejectCrossSiteRequest(request, ctx.config.allowedOrigins)

    const route = `${request.method} ${request.routeOptions.url ?? ''}`
    if (!PUBLIC_ROUTES.has(route) && !request.user) {
      throw new HttpError(401, 'Faça login para continuar.')
    }
  })
}

// Defesa contra CSRF e sequestro de WebSocket: navegadores sempre enviam Origin
// nessas requisições, e ele precisa ser o próprio Harpia.
function rejectCrossSiteRequest(request: FastifyRequest, allowedOrigins: string[]): void {
  const isWebSocket = request.headers.upgrade?.toLowerCase() === 'websocket'
  const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  if (!isWebSocket && !changesState) return
  const origin = request.headers.origin
  if (!origin) return
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new HttpError(403, 'Origem da requisição inválida.')
  }
  if (parsed.host !== request.headers.host && !allowedOrigins.includes(parsed.origin)) {
    throw new HttpError(403, 'Requisição de outro site bloqueada.')
  }
}

export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw new HttpError(401, 'Faça login para continuar.')
  return request.user
}

export function requireAdmin(request: FastifyRequest): User {
  const user = requireUser(request)
  if (user.role !== 'admin') throw new HttpError(403, 'Só administradores podem fazer isso.')
  return user
}
