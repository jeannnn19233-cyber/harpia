import type { RealtimeMessage } from '../../../shared/types.ts'

// Interface mínima do socket, para facilitar testes.
export interface RealtimeSocket {
  readonly readyState: number
  send(data: string): void
}

const OPEN = 1

// Mantém as conexões abertas e distribui eventos para toda a equipe.
export class RealtimeHub {
  private readonly clients = new Map<RealtimeSocket, number>()

  add(socket: RealtimeSocket, userId: number): void {
    this.clients.set(socket, userId)
    this.broadcastPresence()
  }

  remove(socket: RealtimeSocket): void {
    if (this.clients.delete(socket)) this.broadcastPresence()
  }

  onlineUserIds(): number[] {
    return [...new Set(this.clients.values())].sort((a, b) => a - b)
  }

  broadcast(message: RealtimeMessage): void {
    const data = JSON.stringify(message)
    for (const socket of this.clients.keys()) {
      if (socket.readyState === OPEN) socket.send(data)
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', userIds: this.onlineUserIds() })
  }
}
