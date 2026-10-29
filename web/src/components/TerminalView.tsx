import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'

export interface TerminalControls {
  // Digita um texto no terminal, como se a pessoa tivesse digitado.
  type(text: string): void
}

const CLOSE_MESSAGES: Record<number, string> = {
  1000: 'O terminal foi fechado.',
  4403: 'Este terminal é pessoal de outra pessoa.',
  4404: 'Sessão não encontrada.',
  4410: 'Esta sessão já foi encerrada.',
  4503: 'Os terminais estão desligados no servidor.'
}

export function TerminalView({
  sessionId,
  readOnly,
  controls
}: {
  sessionId: number
  readOnly: boolean
  controls?: Ref<TerminalControls>
}) {
  const container = useRef<HTMLDivElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [closed, setClosed] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)

  useImperativeHandle(controls, () => ({
    type(text: string) {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: text }))
    }
  }))

  useEffect(() => {
    const element = container.current
    if (!element) return
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      theme: { background: '#0e1411', foreground: '#cbd9cb', cursor: '#a4c395', selectionBackground: '#3a5140' }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    fit.fit()

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${protocol}://${location.host}/api/sessions/${sessionId}/terminal?cols=${terminal.cols}&rows=${terminal.rows}`
    )
    socketRef.current = socket
    socket.onopen = () => setConnecting(false)
    socket.onmessage = (event) => terminal.write(String(event.data))
    socket.onclose = (event) => {
      setConnecting(false)
      setClosed(CLOSE_MESSAGES[event.code] ?? (event.reason || 'A conexão com o terminal caiu.'))
    }

    const input = terminal.onData((data) => {
      if (!readOnly && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    const sendSize = () => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    }
    const observer = new ResizeObserver(() => sendSize())
    observer.observe(element)
    if (!readOnly) terminal.focus()

    return () => {
      observer.disconnect()
      input.dispose()
      socket.onclose = null
      socket.close()
      terminal.dispose()
      socketRef.current = null
    }
  }, [sessionId, readOnly])

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={container} className="h-full w-full bg-zinc-950 p-2" data-testid="terminal" />
      {connecting && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
          Conectando ao terminal…
        </div>
      )}
      {closed && (
        <div className="absolute inset-x-0 bottom-0 bg-zinc-900/95 px-4 py-2 text-sm text-zinc-300">{closed}</div>
      )}
    </div>
  )
}
