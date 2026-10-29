import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import { requireUser } from '../auth/guard.ts'

export function registerRealtimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/ws', { websocket: true }, (socket, request) => {
    const user = requireUser(request)
    ctx.hub.add(socket, user.id)
    socket.on('close', () => ctx.hub.remove(socket))
    socket.on('error', () => ctx.hub.remove(socket))
    // O cliente só escuta. Mensagens recebidas são ignoradas.
  })
}
