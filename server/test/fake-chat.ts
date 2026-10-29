import type { PermissionMode } from '../../shared/types.ts'
import type { ProviderAdapter, ProviderFactory, ProviderHooks, ProviderInput } from '../src/chat/providers/types.ts'

// Provedor de chat controlado pelo teste: o teste decide o que o "agente" responde.
export class FakeProvider implements ProviderAdapter {
  readonly input: ProviderInput
  readonly sent: string[] = []
  readonly steered: string[] = []
  interrupted = 0
  closed = false
  mode: PermissionMode

  constructor(input: ProviderInput) {
    this.input = input
    this.mode = input.permissionMode
  }

  get hooks(): ProviderHooks {
    return this.input.hooks
  }

  async send(text: string): Promise<void> {
    this.sent.push(text)
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text)
  }

  async interrupt(): Promise<void> {
    this.interrupted++
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
  }

  close(): void {
    this.closed = true
  }
}

export function fakeProviders(): { factory: ProviderFactory; created: FakeProvider[]; last(): FakeProvider } {
  const created: FakeProvider[] = []
  return {
    created,
    factory: (input) => {
      const provider = new FakeProvider(input)
      created.push(provider)
      return provider
    },
    last() {
      const provider = created.at(-1)
      if (!provider) throw new Error('Nenhum provedor criado.')
      return provider
    }
  }
}
