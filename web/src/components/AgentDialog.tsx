import { useEffect, useRef, useState } from 'react'
import { api, type VaultStatus } from '../lib/api.ts'
import { timeAgo } from '../lib/format.ts'
import { Dialog } from './Dialogs.tsx'
import { TerminalView, type TerminalControls } from './TerminalView.tsx'
import { TelegramSection } from './Watcher.tsx'

const KINDS: Record<string, string> = {
  text: 'texto',
  link: 'link',
  photo: 'foto',
  document: 'documento',
  voice: 'áudio',
  audio: 'áudio',
  video: 'vídeo'
}

// "Meu agente": o agente pessoal no Telegram (como o Hermes), que guarda tudo no cofre do Obsidian
// e responde usando o que está lá.
export function AgentDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminal = useRef<TerminalControls>(null)

  const refresh = () =>
    api
      .vault()
      .then(setStatus)
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void refresh()
  }, [])

  const openTerminal = async () => {
    try {
      setSessionId((await api.openPersonalTerminal()).session.id)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const obsidian = status?.obsidian
  return (
    <Dialog title="Meu agente" onClose={onClose} wide>
      <div className="space-y-5">
        <p className="text-sm text-zinc-400">
          Mande qualquer coisa para o bot no Telegram: ideias, links, fotos, PDFs. Tudo fica guardado no seu cofre do Obsidian, e o seu Claude organiza as
          notas e responde as suas perguntas usando o que está lá. Ele trabalha só dentro do cofre, sem terminal.
        </p>

        <TelegramSection title="1. Telegram" linkedText="É só conversar com o bot." bordered={false} linkLabel="Conectar meu Telegram" />

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">2. Cofre (Obsidian)</h3>
          {status?.disabledReason ? (
            <p className="text-sm text-zinc-500">{status.disabledReason}</p>
          ) : !obsidian ? (
            <p className="text-sm text-zinc-500">Carregando…</p>
          ) : (
            <>
              <p className="text-sm">
                Pasta no servidor: <code className="text-zinc-300">{status?.folder}</code> ·{' '}
                {!obsidian.available ? (
                  <span className="text-zinc-500">o Obsidian Sync não está instalado no servidor</span>
                ) : obsidian.syncing ? (
                  <span className="text-emerald-400">sincronizando com o Obsidian</span>
                ) : obsidian.configured ? (
                  <span className="text-amber-300">configurado, iniciando a sincronização…</span>
                ) : (
                  <span className="text-zinc-500">Obsidian Sync não conectado (o cofre fica só no servidor)</span>
                )}
              </p>
              {obsidian.available && !obsidian.configured && (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">
                    Para ver e editar o cofre no celular e no computador, conecte o seu Obsidian Sync (precisa da assinatura do Obsidian Sync):
                  </p>
                  {sessionId === null ? (
                    <button className="btn-primary py-1.5" onClick={() => void openTerminal()}>
                      Abrir meu terminal para conectar
                    </button>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('ob login\r')}>
                          1. Entrar no Obsidian
                        </button>
                        <button className="btn-outline py-1.5" onClick={() => terminal.current?.type('ob sync-list-remote\r')}>
                          2. Ver meus cofres
                        </button>
                        <button
                          className="btn-outline py-1.5"
                          onClick={() => terminal.current?.type('ob sync-setup --path ~/cofre --vault "')}
                          title="Complete com o nome do cofre e feche as aspas"
                        >
                          3. Ligar ao cofre
                        </button>
                        <button className="btn-ghost py-1.5" onClick={() => void refresh()}>
                          Verificar
                        </button>
                      </div>
                      <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-400">
                        <li>No passo 1, use o e-mail e a senha da sua conta do Obsidian (e o código de 2 fatores, se tiver).</li>
                        <li>No passo 3, complete com o nome do cofre que apareceu no passo 2, feche as aspas e tecle Enter.</li>
                        <li>Depois clique em "Verificar": o Harpia mantém a sincronização ligada o tempo todo.</li>
                      </ul>
                      <div className="h-72 overflow-hidden rounded-lg border border-zinc-800">
                        <TerminalView sessionId={sessionId} readOnly={false} controls={terminal} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Comandos no Telegram</h3>
          <ul className="grid gap-1 text-xs text-zinc-400 sm:grid-cols-2">
            <li>
              <code className="text-zinc-300">/novo</code> — começa uma conversa nova
            </li>
            <li>
              <code className="text-zinc-300">/rotinas</code> — lista as suas rotinas
            </li>
            <li>
              <code className="text-zinc-300">/rodar nome</code> — roda uma rotina agora
            </li>
            <li>
              <code className="text-zinc-300">/pausar nome</code> · <code className="text-zinc-300">/retomar nome</code>
            </li>
          </ul>
        </section>

        {status && status.items > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Guardado por último ({status.items} no total)</h3>
            <ul className="space-y-1 text-xs">
              {status.recent.map((item) => (
                <li key={item.path} className="flex gap-2 text-zinc-400">
                  <span className="w-16 shrink-0 text-zinc-500">{KINDS[item.kind] ?? item.kind}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{item.path}</span>
                  <span className="shrink-0 text-zinc-500">{timeAgo(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </div>
    </Dialog>
  )
}
