import { randomBytes } from 'node:crypto'
import { hashToken } from '../auth/passwords.ts'
import { getUser } from '../auth/users.ts'
import type { Db } from '../db/index.ts'
import { markdownToTelegramHtml, splitMessage } from './format.ts'
import type { TelegramClient, TelegramUpdate } from './telegram.ts'

const CODE_MINUTES = 15
// Sem letras e números que se confundem (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function newCode(): string {
  const bytes = randomBytes(8)
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
}

interface NotifierOptions {
  db: Db
  now: () => Date
  telegram: TelegramClient | null
  isOnline: (userId: number) => boolean
  // Endereço do Harpia para colocar links nas mensagens, quando conhecido.
  publicUrl: string | null
  // false deixa a leitura das mensagens do bot por conta de quem chama pollOnce (testes).
  autoPoll: boolean
  warn: (error: unknown, message: string) => void
}

// Avisos para os sócios fora do Harpia (por enquanto, Telegram).
export class Notifier {
  private readonly options: NotifierOptions
  private offset = 0
  private running = false
  botUsername: string | null = null

  constructor(options: NotifierOptions) {
    this.options = options
  }

  available(): boolean {
    return this.options.telegram !== null
  }

  link(path: string): string {
    return this.options.publicUrl ? `\n${this.options.publicUrl}${path}` : ''
  }

  async start(): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram || this.running) return
    this.running = true
    try {
      this.botUsername = (await telegram.getMe()).username
    } catch (error) {
      this.options.warn(error, 'Não foi possível falar com o bot do Telegram.')
    }
    if (!this.options.autoPoll) return
    void (async () => {
      while (this.running) {
        const started = Date.now()
        try {
          await this.pollOnce(25)
        } catch (error) {
          this.options.warn(error, 'Falha ao ler mensagens do Telegram.')
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }
        // O Telegram segura o pedido até chegar mensagem. Se ele responder na hora (erro de rede,
        // limite), espera um pouco para nunca girar sem parar.
        const elapsed = Date.now() - started
        if (elapsed < 1000) await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed))
      }
    })()
  }

  stop(): void {
    this.running = false
  }

  // Lê as mensagens novas do bot (usado pelo laço e pelos testes).
  async pollOnce(timeoutSeconds = 0): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram) return
    const updates = await telegram.getUpdates(this.offset, timeoutSeconds)
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1)
      await this.handleUpdate(update)
    }
  }

  // Código de uso único que a pessoa manda para o bot para vincular a conta dela.
  createLinkCode(userId: number): { code: string; url: string | null; expiresAt: string } {
    const code = newCode()
    const expiresAt = new Date(this.options.now().getTime() + CODE_MINUTES * 60 * 1000).toISOString()
    this.options.db.prepare('DELETE FROM notification_link_codes WHERE user_id = ? AND platform = ?').run(userId, 'telegram')
    this.options.db
      .prepare('INSERT INTO notification_link_codes (code_hash, user_id, platform, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(code), userId, 'telegram', expiresAt)
    return { code, url: this.botUsername ? `https://t.me/${this.botUsername}?start=${code}` : null, expiresAt }
  }

  isLinked(userId: number): boolean {
    return (
      this.options.db
        .prepare('SELECT 1 FROM notification_targets WHERE user_id = ? AND platform = ?')
        .get(userId, 'telegram') !== undefined
    )
  }

  unlink(userId: number): void {
    this.options.db.prepare('DELETE FROM notification_targets WHERE user_id = ? AND platform = ?').run(userId, 'telegram')
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const telegram = this.options.telegram
    if (!message?.text || !telegram) return
    const chatId = String(message.chat.id)
    const code = message.text
      .replace(/^\/start\s*/, '')
      .trim()
      .toUpperCase()
    const row = code
      ? (this.options.db
          .prepare('SELECT user_id, expires_at FROM notification_link_codes WHERE code_hash = ? AND platform = ?')
          .get(hashToken(code), 'telegram') as { user_id: number; expires_at: string } | undefined)
      : undefined
    if (!row || row.expires_at <= this.options.now().toISOString()) {
      await telegram.sendMessage(
        chatId,
        'Olá! Para receber os avisos do Harpia, gere um código em "Avisos" no Harpia e mande ele aqui.'
      )
      return
    }
    this.options.db.prepare('DELETE FROM notification_link_codes WHERE code_hash = ?').run(hashToken(code))
    this.options.db
      .prepare(
        `INSERT INTO notification_targets (user_id, platform, chat_id, linked_at) VALUES (?, 'telegram', ?, ?)
         ON CONFLICT (user_id, platform) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at`
      )
      .run(row.user_id, chatId, this.options.now().toISOString())
    const name = getUser(this.options.db, row.user_id)?.name.split(' ')[0] ?? ''
    await telegram.sendMessage(chatId, `Pronto, ${name}! A partir de agora você recebe aqui os avisos do Harpia.`)
  }

  chatIdOf(userId: number): string | null {
    const target = this.options.db
      .prepare('SELECT chat_id FROM notification_targets WHERE user_id = ? AND platform = ?')
      .get(userId, 'telegram') as { chat_id: string } | undefined
    return target?.chat_id ?? null
  }

  // Manda uma resposta de agente (markdown) para a pessoa, formatada e em partes. Se o Telegram
  // recusar o HTML, manda o texto puro. true = chegou.
  async sendTo(userId: number, markdown: string): Promise<boolean> {
    const telegram = this.options.telegram
    const chatId = this.chatIdOf(userId)
    if (!telegram || !chatId) return false
    try {
      for (const part of splitMessage(markdown)) {
        try {
          await telegram.sendMessage(chatId, markdownToTelegramHtml(part), { html: true })
        } catch {
          await telegram.sendMessage(chatId, part)
        }
      }
      return true
    } catch (error) {
      this.options.warn(error, 'Não foi possível mandar a mensagem pelo Telegram.')
      return false
    }
  }

  // Manda o aviso para as pessoas que vincularam o Telegram. Com onlyOffline, pula quem está
  // com o Harpia aberto (essa pessoa já vê o aviso na tela).
  async notifyUsers(userIds: number[], text: string, options: { onlyOffline?: boolean } = {}): Promise<void> {
    const telegram = this.options.telegram
    if (!telegram) return
    for (const userId of new Set(userIds)) {
      if (options.onlyOffline && this.options.isOnline(userId)) continue
      const target = this.options.db
        .prepare('SELECT chat_id FROM notification_targets WHERE user_id = ? AND platform = ?')
        .get(userId, 'telegram') as { chat_id: string } | undefined
      if (!target) continue
      try {
        await telegram.sendMessage(target.chat_id, text)
      } catch (error) {
        this.options.warn(error, 'Não foi possível mandar o aviso pelo Telegram.')
      }
    }
  }
}
