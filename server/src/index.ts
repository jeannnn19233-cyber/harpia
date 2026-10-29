import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.ts'
import { createTelegramClient } from './notify/telegram.ts'

// Arquivos criados pelo servidor (espelhos dos repositórios, configurações) nunca ficam
// graváveis por outros usuários, incluindo os usuários dos agentes.
process.umask(0o022)

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
    setupCode: process.env.HARPIA_SETUP_CODE?.trim() || null,
    terminalsEnabled: process.env.HARPIA_TERMINALS === 'on',
    maxSessionsPerUser: Number(process.env.HARPIA_MAX_SESSIONS_PER_USER ?? 5),
    prPollSeconds: Number(process.env.HARPIA_PR_POLL_SECONDS ?? 60),
    watcherIntervalSeconds: Number(process.env.HARPIA_WATCHER_INTERVAL_SECONDS ?? 300),
    routineTickSeconds: 30,
    maxConcurrentRuns: Number(process.env.HARPIA_MAX_CONCURRENT_RUNS ?? 3),
    reviewPollSeconds: Number(process.env.HARPIA_REVIEW_POLL_SECONDS ?? 180),
    reviewSettleSeconds: Number(process.env.HARPIA_REVIEW_SETTLE_SECONDS ?? 180),
    vaultSyncSeconds: 120,
    staleHours: Number(process.env.HARPIA_STALE_HOURS ?? 48),
    reviewHours: Number(process.env.HARPIA_REVIEW_HOURS ?? 24)
  },
  telegram: process.env.HARPIA_TELEGRAM_BOT_TOKEN ? createTelegramClient(process.env.HARPIA_TELEGRAM_BOT_TOKEN) : null,
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
