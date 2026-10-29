import { createHash } from 'node:crypto'
import type { User } from '../../../shared/types.ts'
import { describeSchedule } from '../../../shared/schedule.ts'
import { agentsDisabledReason } from '../agents/workspace.ts'
import { WEB_TOOLS, WRITE_TOOLS } from '../automation/policy.ts'
import type { ChatManager } from '../chat/manager.ts'
import { getChat, insertChat, type StoredChat } from '../chat/store.ts'
import type { AppContext } from '../context.ts'
import type { TelegramFile, TelegramMessage } from '../notify/telegram.ts'
import type { RoutineRunner } from '../routines/runner.ts'
import { findRoutineByName, listUserRoutines, updateRoutine } from '../routines/store.ts'
import { nextRun } from '../routines/schedule.ts'
import { vaultInstructions } from './instructions.ts'
import { VAULT_FOLDER } from './paths.ts'

type ItemKind = 'text' | 'link' | 'photo' | 'document' | 'voice' | 'audio' | 'video'

// Limite da API de bots do Telegram para baixar arquivos.
const MAX_FILE_BYTES = 20 * 1024 * 1024
const TIMEZONE = 'America/Sao_Paulo'

const HELP = [
  'Sou o seu agente pessoal no Harpia. Tudo o que você me manda (texto, links, fotos, PDFs, áudios) fica guardado no seu cofre, e eu organizo e respondo usando o que está lá.',
  '',
  '/novo — começa uma conversa nova (o cofre continua o mesmo)',
  '/rotinas — lista as suas rotinas',
  '/rodar nome — roda uma rotina agora',
  '/pausar nome · /retomar nome — pausa ou retoma uma rotina'
].join('\n')

function stamp(date: Date): { day: string; time: string; label: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  )
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}${parts.minute}${parts.second}`,
    label: date.toLocaleString('pt-BR', { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' })
  }
}

function safeName(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-80) || 'arquivo'
  )
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4'
}

// O que veio na mensagem, e o arquivo anexo (se houver).
function classify(message: TelegramMessage): { kind: ItemKind; file: TelegramFile | null; fileName: string | null } {
  if (message.photo?.length) return { kind: 'photo', file: message.photo.at(-1)!, fileName: 'foto.jpg' }
  if (message.document) {
    const name = message.document.file_name ?? `documento${EXTENSIONS[message.document.mime_type ?? ''] ?? ''}`
    return { kind: 'document', file: message.document, fileName: name }
  }
  if (message.voice) return { kind: 'voice', file: message.voice, fileName: 'audio.ogg' }
  if (message.audio) return { kind: 'audio', file: message.audio, fileName: message.audio.file_name ?? 'audio.mp3' }
  if (message.video) return { kind: 'video', file: message.video, fileName: message.video.file_name ?? 'video.mp4' }
  const text = (message.text ?? '').trim()
  if (/^https?:\/\/\S+$/.test(text)) return { kind: 'link', file: null, fileName: null }
  return { kind: 'text', file: null, fileName: null }
}

const KIND_LABELS: Record<ItemKind, string> = {
  text: 'texto',
  link: 'link',
  photo: 'foto',
  document: 'documento',
  voice: 'áudio (mensagem de voz)',
  audio: 'áudio',
  video: 'vídeo'
}

// O agente pessoal de cada pessoa no Telegram (como o Hermes): guarda tudo no cofre na hora, sem IA,
// e conversa pelo Claude da pessoa, que trabalha dentro do cofre, organiza e responde.
export class PersonalAgent {
  private readonly ctx: AppContext
  private readonly manager: ChatManager
  private readonly routines: RoutineRunner
  private readonly inactivityMs: number | undefined
  private readonly turns = new Set<Promise<void>>()

  constructor(ctx: AppContext, manager: ChatManager, routines: RoutineRunner, options: { inactivityMs?: number } = {}) {
    this.ctx = ctx
    this.manager = manager
    this.routines = routines
    this.inactivityMs = options.inactivityMs
  }

  async idle(): Promise<void> {
    while (this.turns.size > 0) await Promise.allSettled([...this.turns])
  }

  private reply(user: User, text: string): Promise<boolean> {
    return this.ctx.notifier.sendTo(user.id, text)
  }

  async handleMessage(user: User, message: TelegramMessage, chatId: string): Promise<void> {
    const text = (message.text ?? message.caption ?? '').trim()
    if (text.startsWith('/') && (await this.command(user, text))) return

    const disabled = agentsDisabledReason(this.ctx)
    if (disabled) {
      await this.reply(user, `Não consigo guardar nem responder agora: ${disabled}`)
      return
    }

    const saved = await this.capture(user, message, chatId, text)
    if (!saved) return

    const chat = await this.conversation(user)
    const when = stamp(new Date((message.date ?? this.ctx.now().getTime() / 1000) * 1000)).label
    const prompt = [
      `[Telegram · ${when}]`,
      text || '(sem texto)',
      '',
      `Original salvo em ${saved.note}${saved.file ? `; ${KIND_LABELS[saved.kind]} em ${saved.file}` : ''}.`,
      saved.problem ?? ''
    ]
      .filter((line, index, lines) => line !== '' || index < lines.length - 1)
      .join('\n')
      .trim()

    // Com o agente no meio de uma resposta, a mensagem entra na mesma vez (como no Claude Code).
    if (chat.status === 'working' || chat.status === 'waiting') {
      await this.manager.send(chat, user, prompt)
      return
    }
    const turn = this.runTurn(user, chat, prompt, chatId, saved.note)
    this.turns.add(turn)
    void turn.finally(() => this.turns.delete(turn))
  }

  private async runTurn(user: User, chat: StoredChat, prompt: string, chatId: string, note: string): Promise<void> {
    const telegram = this.ctx.notifier.client()
    const typing = setInterval(() => void telegram?.sendTyping(chatId).catch(() => undefined), 4500)
    void telegram?.sendTyping(chatId).catch(() => undefined)
    try {
      const result = await this.manager.runTurn(chat, prompt, { inactivityMs: this.inactivityMs })
      if (result.error) {
        await this.reply(user, `Guardei no cofre (${note}), mas não consegui falar com o seu Claude: ${result.error}`)
      } else {
        await this.reply(user, result.text || 'Feito.')
      }
    } catch (error) {
      await this.reply(user, `Guardei no cofre (${note}), mas algo deu errado: ${(error as Error).message}`)
    } finally {
      clearInterval(typing)
    }
  }

  // Guarda o original em raw/telegram/AAAA-MM-DD/, como a pessoa, antes de qualquer IA.
  private async capture(
    user: User,
    message: TelegramMessage,
    chatId: string,
    text: string
  ): Promise<{ note: string; file: string | null; kind: ItemKind; problem: string | null } | null> {
    const sourceRef = `${chatId}:${message.message_id ?? Date.now()}`
    const exists = this.ctx.db.prepare('SELECT 1 FROM vault_items WHERE user_id = ? AND source_ref = ?').get(user.id, sourceRef)
    if (exists) return null
    const received = new Date((message.date ?? this.ctx.now().getTime() / 1000) * 1000)
    const { day, time } = stamp(received)
    const base = `raw/telegram/${day}/${time}-${message.message_id ?? 0}`
    const { kind, file, fileName } = classify(message)

    let filePath: string | null = null
    let problem: string | null = null
    let content: Buffer | null = null
    if (file) {
      const telegram = this.ctx.notifier.client()
      if ((file.file_size ?? 0) > MAX_FILE_BYTES) {
        problem = 'O arquivo passa de 20 MB, o limite do Telegram para bots: não foi baixado.'
      } else if (telegram) {
        try {
          content = await telegram.downloadFile(file.file_id)
          filePath = `${base}-${safeName(fileName ?? 'arquivo')}`
          await this.ctx.agents.writeUserFile(user, `${VAULT_FOLDER}/${filePath}`, content)
        } catch (error) {
          filePath = null
          problem = `Não consegui baixar o arquivo: ${(error as Error).message}`
        }
      }
      if (kind === 'voice' || kind === 'audio') problem = [problem, 'O áudio não tem transcrição.'].filter(Boolean).join(' ')
    }

    const hash = createHash('sha256')
      .update(text)
      .update(content ?? '')
      .digest('hex')
    const note = `${base}.md`
    const frontmatter = [
      '---',
      'source: telegram',
      `received: ${received.toISOString()}`,
      `kind: ${kind}`,
      filePath ? `file: "${filePath.split('/').at(-1)}"` : null,
      `sha256: ${hash}`,
      '---'
    ]
      .filter(Boolean)
      .join('\n')
    const body = [text, filePath ? `![[${filePath.split('/').at(-1)}]]` : ''].filter(Boolean).join('\n\n')
    await this.ctx.agents.writeUserFile(user, `${VAULT_FOLDER}/${note}`, `${frontmatter}\n\n${body}\n`)
    this.ctx.db
      .prepare('INSERT INTO vault_items (user_id, source_ref, kind, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, sourceRef, kind, note, this.ctx.now().toISOString())
    return { note, file: filePath, kind, problem }
  }

  // A conversa do Telegram em andamento (uma por pessoa), ou uma nova.
  private async conversation(user: User): Promise<StoredChat> {
    const row = this.ctx.db
      .prepare("SELECT id FROM chats WHERE user_id = ? AND origin = 'telegram' AND status != 'closed' ORDER BY id DESC LIMIT 1")
      .get(user.id) as { id: number } | undefined
    const existing = row ? getChat(this.ctx.db, row.id) : null
    if (existing) return existing
    const vault = await this.ctx.agents.prepareFolder(user, VAULT_FOLDER)
    const chat = insertChat(this.ctx.db, {
      taskId: null,
      userId: user.id,
      provider: 'claude',
      permissionMode: 'auto',
      branch: null,
      cwd: vault,
      origin: 'telegram',
      title: `Telegram · ${stamp(this.ctx.now()).label}`,
      policy: { tools: [...WRITE_TOOLS, ...WEB_TOOLS], roots: [vault] },
      instructions: vaultInstructions(user.name.split(' ')[0]),
      now: this.ctx.now()
    })
    this.manager.publish(chat)
    return chat
  }

  // Comandos do Telegram. false quando não é um comando conhecido (vira mensagem comum).
  private async command(user: User, text: string): Promise<boolean> {
    const [raw, ...rest] = text.split(/\s+/)
    const name = raw.replace(/@\w+$/, '').toLowerCase()
    const argument = rest.join(' ').trim()
    switch (name) {
      case '/start':
      case '/ajuda':
      case '/help':
        await this.reply(user, HELP)
        return true
      case '/novo': {
        const row = this.ctx.db
          .prepare("SELECT id FROM chats WHERE user_id = ? AND origin = 'telegram' AND status != 'closed' ORDER BY id DESC LIMIT 1")
          .get(user.id) as { id: number } | undefined
        const chat = row ? getChat(this.ctx.db, row.id) : null
        if (chat) this.manager.close(chat)
        await this.reply(user, 'Pronto, começamos uma conversa nova. O cofre continua o mesmo.')
        return true
      }
      case '/rotinas': {
        const routines = listUserRoutines(this.ctx.db, user.id)
        if (routines.length === 0) {
          await this.reply(user, 'Você ainda não tem rotinas. Crie em "Rotinas" no Harpia.')
          return true
        }
        const lines = routines.map((routine) => `- **${routine.name}** — ${routine.enabled ? describeSchedule(routine.schedule) : 'pausada'}`)
        await this.reply(user, `${lines.join('\n')}\n\nUse /rodar nome para rodar agora.`)
        return true
      }
      case '/rodar':
      case '/pausar':
      case '/retomar': {
        if (!argument) {
          await this.reply(user, `Diga qual rotina: ${name} nome`)
          return true
        }
        const found = findRoutineByName(this.ctx.db, user.id, argument)
        if (found.length !== 1) {
          await this.reply(
            user,
            found.length === 0
              ? `Não achei a rotina "${argument}". Veja as suas com /rotinas.`
              : `Achei mais de uma: ${found.map((routine) => routine.name).join(', ')}. Seja mais específico.`
          )
          return true
        }
        const routine = found[0]
        if (name === '/rodar') {
          try {
            this.routines.runNow(routine)
            await this.reply(user, `Rodando "${routine.name}". O resultado chega aqui.`)
          } catch (error) {
            await this.reply(user, (error as Error).message)
          }
          return true
        }
        const enabled = name === '/retomar'
        const now = this.ctx.now()
        const updated = updateRoutine(
          this.ctx.db,
          routine.id,
          {
            enabled,
            nextRunAt: enabled ? (nextRun(routine.schedule, routine.timezone, now)?.toISOString() ?? null) : null,
            ...(enabled ? { failureStreak: 0, holdUntil: null } : {})
          },
          now
        )
        this.routines.publishRoutine(updated)
        await this.reply(user, enabled ? `"${routine.name}" retomada.` : `"${routine.name}" pausada.`)
        return true
      }
      default:
        return false
    }
  }
}
