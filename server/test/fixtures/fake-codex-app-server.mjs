// Imita o "codex app-server": responde ao protocolo JSON-RPC por linhas, como o Codex real.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (method, params) => send({ method, params })
let pendingApproval = null

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'fake' } })
  if (message.method === 'initialized') return
  if (message.method === 'thread/start') {
    if (message.params.cwd !== process.env.EXPECTED_CWD) return send({ id: message.id, error: { message: `cwd errado: ${message.params.cwd}` } })
    return send({ id: message.id, result: { thread: { id: 'thread-novo' } } })
  }
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId } } })
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    const text = message.params.input[0].text
    notify('turn/started', { threadId: message.params.threadId, turn: { id: 'turn-1' } })
    notify('error', { error: { message: 'Reconnecting... 2/5' }, willRetry: true })
    notify('item/started', { item: { type: 'agentMessage', id: 'msg-1', text: '' } })
    notify('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Rodando ' })
    notify('item/agentMessage/delta', { itemId: 'msg-1', delta: `"${text}"` })
    pendingApproval = 'srv-1'
    return send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'rodar testes' } })
  }
  if (message.id === pendingApproval) {
    pendingApproval = null
    if (message.result.decision === 'accept') {
      notify('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test' } })
      notify('item/completed', { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok 3 testes' } })
      notify('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'Rodando "testes". Pronto.' } })
      return notify('turn/completed', { threadId: 'thread-novo', turn: { id: 'turn-1', status: 'completed', error: null } })
    }
    return notify('turn/completed', { threadId: 'thread-novo', turn: { id: 'turn-1', status: 'failed', error: { message: 'Comando recusado' } } })
  }
  if (message.method === 'turn/interrupt') return send({ id: message.id, result: {} })
})
