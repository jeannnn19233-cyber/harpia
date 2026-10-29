import type { Chat, ChatItem, ChatItemKind, ChatOrigin, ChatProvider, ChatStatus, PermissionMode } from '../../../shared/types.ts'
import type { AutomationPolicy } from '../automation/policy.ts'
import type { Db } from '../db/index.ts'

interface ChatRow {
  id: number
  task_id: number | null
  user_id: number
  provider: ChatProvider
  title: string
  status: ChatStatus
  permission_mode: PermissionMode
  provider_session_id: string | null
  suggestion: string | null
  model: string | null
  shared: number
  origin: ChatOrigin
  policy: string | null
  instructions: string | null
  branch: string | null
  cwd: string
  created_at: string
  updated_at: string
}

interface ItemRow {
  id: number
  chat_id: number
  kind: ChatItemKind
  data: string
  created_at: string
  updated_at: string
}

export interface StoredChat extends Chat {
  cwd: string
  providerSessionId: string | null
  // Execuções automáticas: ferramentas e pastas fixas, e instruções próprias (só no servidor).
  policy: AutomationPolicy | null
  instructions: string | null
}

// Campos de cada tipo de item, sem os comuns (id, chatId, datas).
export type ChatItemData = ChatItem extends infer Item
  ? Item extends ChatItem
    ? Omit<Item, 'id' | 'chatId' | 'createdAt' | 'updatedAt'>
    : never
  : never

function toChat(row: ChatRow): StoredChat {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    provider: row.provider,
    title: row.title,
    status: row.status,
    permissionMode: row.permission_mode,
    providerSessionId: row.provider_session_id,
    branch: row.branch,
    suggestion: row.suggestion,
    model: row.model,
    shared: row.shared === 1,
    origin: row.origin,
    policy: row.policy ? (JSON.parse(row.policy) as AutomationPolicy) : null,
    instructions: row.instructions,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// O caminho no servidor e o id interno do provedor não vão para a interface.
export function publicChat(chat: StoredChat): Chat {
  const { cwd: _cwd, providerSessionId: _providerSessionId, policy: _policy, instructions: _instructions, ...rest } = chat
  return rest
}

function toItem(row: ItemRow): ChatItem {
  return {
    ...(JSON.parse(row.data) as object),
    kind: row.kind,
    id: row.id,
    chatId: row.chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } as ChatItem
}

export function getChat(db: Db, id: number): StoredChat | null {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined
  return row ? toChat(row) : null
}

export function listTaskChats(db: Db, taskId: number): StoredChat[] {
  const rows = db.prepare('SELECT * FROM chats WHERE task_id = ? ORDER BY id').all(taskId) as unknown as ChatRow[]
  return rows.map(toChat)
}

// Conversas abertas em tasks, para o quadro mostrar quem está trabalhando onde.
export function listActiveChats(db: Db): StoredChat[] {
  const rows = db
    .prepare("SELECT * FROM chats WHERE status != 'closed' AND task_id IS NOT NULL ORDER BY id")
    .all() as unknown as ChatRow[]
  return rows.map(toChat)
}

// Quem pode ver a conversa: as de task, toda a equipe; as outras, só a dona, a menos que compartilhadas.
export function canSeeChat(chat: Chat, userId: number): boolean {
  return chat.taskId !== null || chat.shared || chat.userId === userId
}

// Conversas fora das tasks que a pessoa pode ver: as dela e as compartilhadas pela equipe.
export function listGeneralChats(db: Db, userId: number): StoredChat[] {
  const rows = db
    .prepare(
      `SELECT * FROM chats WHERE task_id IS NULL AND origin IN ('user', 'telegram') AND (user_id = ? OR shared = 1)
       ORDER BY updated_at DESC, id DESC`
    )
    .all(userId) as unknown as ChatRow[]
  return rows.map(toChat)
}

export function deleteChat(db: Db, id: number): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id)
}

export function listBusyChats(db: Db): StoredChat[] {
  const rows = db.prepare("SELECT * FROM chats WHERE status IN ('working', 'waiting')").all() as unknown as ChatRow[]
  return rows.map(toChat)
}

export function insertChat(
  db: Db,
  input: {
    taskId: number | null
    userId: number
    provider: ChatProvider
    permissionMode: PermissionMode
    branch: string | null
    cwd: string
    model?: string | null
    origin?: ChatOrigin
    title?: string
    shared?: boolean
    policy?: AutomationPolicy | null
    instructions?: string | null
    now: Date
  }
): StoredChat {
  const now = input.now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO chats (task_id, user_id, provider, title, status, permission_mode, branch, cwd, model, origin, shared,
                          policy, instructions, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.taskId,
      input.userId,
      input.provider,
      input.title ?? 'Nova conversa',
      input.permissionMode,
      input.branch,
      input.cwd,
      input.model ?? null,
      input.origin ?? 'user',
      input.shared ? 1 : 0,
      input.policy ? JSON.stringify(input.policy) : null,
      input.instructions ?? null,
      now,
      now
    )
  const chat = getChat(db, Number(result.lastInsertRowid))
  if (!chat) throw new Error('Conversa recém-criada não encontrada.')
  return chat
}

export function updateChat(
  db: Db,
  id: number,
  fields: Partial<{
    title: string
    status: ChatStatus
    permissionMode: PermissionMode
    providerSessionId: string
    suggestion: string | null
    model: string | null
    shared: boolean
  }>,
  now: Date
): StoredChat | null {
  const columns: Record<string, string> = {
    title: 'title',
    status: 'status',
    permissionMode: 'permission_mode',
    providerSessionId: 'provider_session_id',
    suggestion: 'suggestion',
    model: 'model',
    shared: 'shared'
  }
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${columns[key]} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  sets.push('updated_at = ?')
  values.push(now.toISOString())
  db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getChat(db, id)
}

export function insertItem(db: Db, chatId: number, data: ChatItemData, now: Date): ChatItem {
  const { kind, ...rest } = data
  const stamp = now.toISOString()
  const result = db
    .prepare('INSERT INTO chat_items (chat_id, kind, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, kind, JSON.stringify(rest), stamp, stamp)
  return getItem(db, Number(result.lastInsertRowid)) as ChatItem
}

export function getItem(db: Db, id: number): ChatItem | null {
  const row = db.prepare('SELECT * FROM chat_items WHERE id = ?').get(id) as ItemRow | undefined
  return row ? toItem(row) : null
}

export function updateItem(db: Db, id: number, data: ChatItemData, now: Date): ChatItem | null {
  const { kind, ...rest } = data
  db.prepare('UPDATE chat_items SET kind = ?, data = ?, updated_at = ? WHERE id = ?').run(
    kind,
    JSON.stringify(rest),
    now.toISOString(),
    id
  )
  return getItem(db, id)
}

export function listItems(db: Db, chatId: number, limit = 2000): ChatItem[] {
  const rows = db
    .prepare('SELECT * FROM (SELECT * FROM chat_items WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .all(chatId, limit) as unknown as ItemRow[]
  return rows.map(toItem)
}

export function itemData(item: ChatItem): ChatItemData {
  const { id: _id, chatId: _chatId, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = item
  return data as ChatItemData
}
