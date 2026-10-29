import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(process.env.HARPIA_DATA_DIR ?? join(homedir(), '.harpia'))
const host = process.env.HARPIA_HOST ?? '127.0.0.1'
const port = Number(process.env.HARPIA_PORT ?? 7420)

const { app } = await buildApp({
  config: {
    dataDir,
    reposDir: join(dataDir, 'repos'),
    cookieSecure: process.env.HARPIA_COOKIE_SECURE === 'true',
    webDir: resolve(process.env.HARPIA_WEB_DIR ?? join(here, '../../web/dist')),
    allowedOrigins: (process.env.HARPIA_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    setupCode: process.env.HARPIA_SETUP_CODE?.trim() || null
  },
  logger: { level: process.env.HARPIA_LOG_LEVEL ?? 'info' }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`Recebido ${signal}, encerrando.`)
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ host, port })
app.log.info(`Harpia rodando em http://${host}:${port} (dados em ${dataDir})`)
