export interface TelegramFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_name?: string
  mime_type?: string
}

export interface TelegramMessage {
  message_id?: number
  date?: number
  chat: { id: number }
  text?: string
  caption?: string
  from?: { first_name?: string }
  // Fotos chegam em vários tamanhos; a última é a maior.
  photo?: TelegramFile[]
  document?: TelegramFile
  voice?: TelegramFile
  audio?: TelegramFile
  video?: TelegramFile
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramClient {
  getMe(): Promise<{ username: string }>
  // Espera até timeoutSeconds por mensagens novas (long polling).
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>
  // html: o texto já vem no HTML limitado do Telegram (veja format.ts).
  sendMessage(chatId: string, text: string, options?: { html?: boolean }): Promise<void>
  // "Digitando…" no chat enquanto o agente trabalha.
  sendTyping(chatId: string): Promise<void>
  // Baixa um arquivo mandado ao bot (até 20 MB, limite da API de bots).
  downloadFile(fileId: string): Promise<Buffer>
}

// Cliente da API de bots do Telegram (HARPIA_TELEGRAM_BOT_TOKEN, criado com o @BotFather).
export function createTelegramClient(token: string): TelegramClient {
  async function call<T>(method: string, body: object, timeoutMs = 15000): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const data = (await response.json()) as { ok: boolean; result: T; description?: string }
    if (!data.ok) throw new Error(`Telegram: ${data.description ?? response.status}`)
    return data.result
  }
  return {
    getMe: () => call('getMe', {}),
    getUpdates: (offset, timeoutSeconds) =>
      call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] }, (timeoutSeconds + 10) * 1000),
    sendTyping: async (chatId) => {
      await call('sendChatAction', { chat_id: chatId, action: 'typing' })
    },
    downloadFile: async (fileId) => {
      const file = await call<{ file_path: string }>('getFile', { file_id: fileId })
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`Telegram: não foi possível baixar o arquivo (${response.status}).`)
      return Buffer.from(await response.arrayBuffer())
    },
    sendMessage: async (chatId, text, options) => {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(options?.html ? { parse_mode: 'HTML' } : {})
      })
    }
  }
}
