import type { TelegramClient, TelegramUpdate } from '../src/notify/telegram.ts'

// Bot do Telegram de mentira: guarda o que foi enviado e entrega as mensagens da fila.
export class FakeTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; html?: boolean }[] = []
  readonly queue: TelegramUpdate[] = []
  readonly files = new Map<string, Buffer>()
  typing = 0

  async getMe() {
    return { username: 'harpia_bot' }
  }
  async getUpdates() {
    return this.queue.splice(0)
  }
  async sendMessage(chatId: string, text: string, options?: { html?: boolean }) {
    this.sent.push(options?.html ? { chatId, text, html: true } : { chatId, text })
  }
  async sendTyping() {
    this.typing++
  }
  async downloadFile(fileId: string) {
    const file = this.files.get(fileId)
    if (!file) throw new Error('arquivo não encontrado')
    return file
  }
}
