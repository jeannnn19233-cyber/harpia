import { Cron } from 'croner'

// Rotinas rodam no máximo a cada 15 minutos: cada execução gasta a cota do Claude da pessoa.
export const MIN_INTERVAL_MINUTES = 15

function cron(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone, paused: true, mode: '5-part' })
}

// Motivo em português quando a expressão não serve; null quando está tudo certo.
export function scheduleProblem(expression: string, timezone: string): string | null {
  let job: Cron
  try {
    job = cron(expression, timezone)
  } catch {
    return 'Horário inválido. Use as opções da tela ou uma expressão cron de 5 campos.'
  }
  const runs = job.nextRuns(6)
  if (runs.length === 0) return 'Esse horário nunca acontece.'
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60 * 1000) {
      return `O intervalo mínimo entre execuções é de ${MIN_INTERVAL_MINUTES} minutos.`
    }
  }
  return null
}

export function nextRun(expression: string, timezone: string, after: Date): Date | null {
  return cron(expression, timezone).nextRun(after)
}

// Execução perdida (servidor fora do ar) ainda roda se o atraso for pequeno: metade do intervalo,
// entre 2 minutos e 2 horas, como no Hermes. Um apagão longo vira uma execução pulada.
export function graceMs(expression: string, timezone: string, slot: Date): number {
  const following = nextRun(expression, timezone, slot)
  const period = following ? following.getTime() - slot.getTime() : 60 * 60 * 1000
  return Math.min(2 * 60 * 60 * 1000, Math.max(2 * 60 * 1000, period / 2))
}
