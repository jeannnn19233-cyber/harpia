export interface TelegramUpdate {
  update_id: number
  message?: { chat: { id: number }; text?: string; from?: { first_name?: string } }
}

export interface TelegramClient {
  getMe(): Promise<{ username: string }>
  // Espera até timeoutSeconds por mensagens novas (long polling).
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>
  sendMessage(chatId: string, text: string): Promise<void>
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
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
    }
  }
}
