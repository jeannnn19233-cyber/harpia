import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'

export class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue?.path.join('.')
    throw new HttpError(400, field ? `Campo inválido: ${field} (${issue.message})` : 'Dados inválidos.')
  }
  return result.data
}

export function parseId(value: unknown): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido.')
  return id
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message })
    }
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
    if (status < 500) {
      return reply.status(status).send({ error: (error as Error).message })
    }
    request.log.error(error)
    return reply.status(500).send({ error: 'Erro interno do servidor.' })
  })
}
