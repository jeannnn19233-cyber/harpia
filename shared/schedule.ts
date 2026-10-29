// Horários das rotinas em português. As rotinas guardam uma expressão cron de 5 campos; a tela
// monta a expressão a partir de opções simples, e esta descrição volta para a tela.

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

function time(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

export type SchedulePreset =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'hours'; every: number }
  | { kind: 'minutes'; every: number }
  | { kind: 'cron'; expression: string }

export function presetToCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case 'daily':
      return `${preset.minute} ${preset.hour} * * *`
    case 'weekdays':
      return `${preset.minute} ${preset.hour} * * 1-5`
    case 'weekly':
      return `${preset.minute} ${preset.hour} * * ${preset.weekday}`
    case 'hours':
      return `0 */${preset.every} * * *`
    case 'minutes':
      return `*/${preset.every} * * * *`
    case 'cron':
      return preset.expression.trim().replace(/\s+/g, ' ')
  }
}

export function cronToPreset(expression: string): SchedulePreset {
  const parts = expression.trim().split(/\s+/)
  if (parts.length === 5) {
    const [minute, hour, day, month, weekday] = parts
    const fixed = /^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*'
    if (fixed && weekday === '*') return { kind: 'daily', hour: Number(hour), minute: Number(minute) }
    if (fixed && weekday === '1-5') return { kind: 'weekdays', hour: Number(hour), minute: Number(minute) }
    if (fixed && /^[0-6]$/.test(weekday)) return { kind: 'weekly', weekday: Number(weekday), hour: Number(hour), minute: Number(minute) }
    const hours = hour.match(/^\*\/(\d+)$/)
    if (minute === '0' && hours && day === '*' && month === '*' && weekday === '*') return { kind: 'hours', every: Number(hours[1]) }
    const minutes = minute.match(/^\*\/(\d+)$/)
    if (minutes && hour === '*' && day === '*' && month === '*' && weekday === '*') return { kind: 'minutes', every: Number(minutes[1]) }
  }
  return { kind: 'cron', expression }
}

export function describeSchedule(expression: string): string {
  const preset = cronToPreset(expression)
  switch (preset.kind) {
    case 'daily':
      return `todo dia às ${time(String(preset.hour), String(preset.minute))}`
    case 'weekdays':
      return `dias úteis às ${time(String(preset.hour), String(preset.minute))}`
    case 'weekly':
      return `toda ${WEEKDAYS[preset.weekday]} às ${time(String(preset.hour), String(preset.minute))}`
    case 'hours':
      return preset.every === 1 ? 'a cada hora' : `a cada ${preset.every} horas`
    case 'minutes':
      return `a cada ${preset.every} minutos`
    case 'cron':
      return `cron: ${preset.expression}`
  }
}
