// Tipos compartilhados entre o servidor e a interface web.

export const TASK_STATUSES = ['backlog', 'in_progress', 'review', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'Em andamento',
  review: 'Revisão',
  done: 'Feito'
}

export type UserRole = 'admin' | 'member'

export interface User {
  id: number
  name: string
  email: string
  role: UserRole
  // Usuário do GitHub, para o Harpia saber de quem é cada PR (revisão automática).
  githubLogin: string | null
  // Sugestão de próxima mensagem nas conversas com o Codex (feita pelo Claude da pessoa).
  codexSuggestions: boolean
  // O GitHub da pessoa está conectado (com o token dela) e o que o revisor dela pode fazer.
  githubConnected: boolean
  reviewMode: ReviewMode
  // Quem o Harpia pede como revisor dos PRs desta pessoa no GitHub.
  preferredReviewerId: number | null
  createdAt: string
}

// O que o revisor de PRs de cada pessoa pode fazer em nome dela no GitHub.
export const REVIEW_MODES = ['full', 'fix', 'comment', 'off'] as const
export type ReviewMode = (typeof REVIEW_MODES)[number]
export const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  full: 'Corrige, dá push e aprova',
  fix: 'Corrige e dá push, sem aprovar',
  comment: 'Só analisa e comenta',
  off: 'Desligado (reviso eu mesmo)'
}

export type CloneStatus = 'pending' | 'cloning' | 'ready' | 'error'

export interface Project {
  id: number
  name: string
  slug: string
  repoUrl: string
  defaultBranch: string
  cloneStatus: CloneStatus
  cloneError: string | null
  createdBy: number
  createdAt: string
  // Revisão automática dos PRs abertos no GitHub.
  prReview: boolean
  // Quem revisa quando o autor não marca ninguém no GitHub.
  defaultReviewerId: number | null
}

// Configuração do revisor de um projeto (as regras ficam só no servidor: podem ter detalhes internos).
export interface ProjectReviewSettings {
  prReview: boolean
  defaultReviewerId: number | null
  rules: string
}

export interface Task {
  id: number
  projectId: number
  number: number
  title: string
  description: string
  status: TaskStatus
  ownerId: number | null
  participantIds: number[]
  position: number
  createdBy: number
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  closedAt: string | null
}

export type TaskEventType =
  | 'watcher_notice'
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_reviewed'
  | 'summarized'
  | 'learning_applied'
  | 'learning_dismissed'
  | 'chat_started'
  | 'agent_started'
  | 'agent_stopped'
  | 'created'
  | 'edited'
  | 'status_changed'
  | 'owner_changed'
  | 'participant_joined'
  | 'participant_left'
  | 'comment'

export interface TaskEvent {
  id: number
  taskId: number
  actorId: number | null
  type: TaskEventType
  data: Record<string, unknown>
  createdAt: string
}

export interface TaskDetail {
  task: Task
  events: TaskEvent[]
}

export interface Invite {
  token: string
  role: UserRole
  expiresAt: string
}

// Agentes de IA e terminais (fase 3).
export const AGENT_KINDS = ['claude', 'codex', 'shell'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export const AGENT_LABELS: Record<AgentKind | 'account', string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal',
  account: 'Terminal pessoal'
}

export interface AgentSession {
  id: number
  // null no terminal pessoal (usado para conectar as contas de IA).
  taskId: number | null
  userId: number
  kind: AgentKind | 'account'
  branch: string | null
  status: 'running' | 'exited'
  createdAt: string
  endedAt: string | null
}

export interface AgentsStatus {
  enabled: boolean
  // Por que os terminais estão desligados, quando estão.
  reason: string | null
}

// Se a pessoa já conectou cada ferramenta de IA no servidor.
export interface AgentAccounts {
  claude: boolean
  codex: boolean
}

// Conversas com os agentes de IA (chat), a forma principal de trabalhar numa task.
export const CHAT_PROVIDERS = ['claude', 'codex'] as const
export type ChatProvider = (typeof CHAT_PROVIDERS)[number]

export const CHAT_PROVIDER_LABELS: Record<ChatProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

// O quanto o agente pode fazer sem pedir aprovação.
export const PERMISSION_MODES = ['ask', 'edits', 'auto'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Pedir aprovação',
  edits: 'Aceitar edições',
  auto: 'Autônomo'
}

// idle: esperando mensagem; working: trabalhando; waiting: esperando aprovação.
export type ChatStatus = 'idle' | 'working' | 'waiting' | 'closed'

// Quem abriu a conversa: a pessoa, uma rotina, a revisão de PR ou o agente pessoal no Telegram.
export type ChatOrigin = 'user' | 'routine' | 'review' | 'telegram'

export interface Chat {
  id: number
  taskId: number | null
  userId: number
  provider: ChatProvider
  title: string
  status: ChatStatus
  permissionMode: PermissionMode
  branch: string | null
  // Próxima mensagem sugerida pelo agente (só o Claude oferece).
  suggestion: string | null
  // Modelo escolhido pela pessoa; null usa o padrão da conta dela.
  model: string | null
  // Conversas fora das tasks são privadas; com shared, a equipe acompanha (só leitura).
  // Conversas de task são sempre visíveis para a equipe.
  shared: boolean
  origin: ChatOrigin
  createdAt: string
  updatedAt: string
}

// Resumo de uma task concluída, escrito pelo Claude de quem estava nela (fase 4b).
export interface TaskSummary {
  taskId: number
  // De quem é o Claude que escreveu.
  userId: number | null
  status: 'running' | 'ready' | 'failed'
  summary: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

// Aprendizado sugerido pela IA ao fim de uma task: vai para o AGENTS.md do repositório (por PR)
// ou para a memória do projeto, depois que alguém da equipe aprova.
export type LearningTarget = 'agents_md' | 'memory'

// Memória por achado de cada PR, entre as rodadas (mesmo formato do revisor_memoria.py do Hermes).
export interface PrFindingHistory {
  rodada: number
  sha: string
  status: PrFindingStatus
  nota: string
}
export type PrFindingStatus = 'aberto' | 'resolvido' | 'retirado'
export interface PrFinding {
  id: string
  arquivo: string | null
  linha: number | null
  resumo: string
  gravidade: 'bloqueia' | 'nao-bloqueia'
  status: PrFindingStatus
  historico: PrFindingHistory[]
}
export interface PrMemory {
  numero: number
  achados: PrFinding[]
  rodadas: { n: number; sha: string; em: string; evento: string | null; resumo: string }[]
  sha_revisado: string | null
  visto_ate: string | null
}

export interface Learning {
  id: number
  taskId: number
  projectId: number
  target: LearningTarget
  text: string
  reason: string
  status: 'pending' | 'applied' | 'dismissed'
  decidedBy: number | null
  prUrl: string | null
  createdAt: string
  decidedAt: string | null
}

export const LEARNING_TARGET_LABELS: Record<LearningTarget, string> = {
  agents_md: 'AGENTS.md do repositório',
  memory: 'memória do projeto'
}

// Revisão automática de um PR (um commit), feita pelo Claude do autor do PR.
export type PrReviewStatus = 'waiting' | 'running' | 'posted' | 'failed' | 'skipped'
// Filas do revisor (como no revisor do Hermes), em ordem de prioridade.
export type PrQueue = 'conflito' | 'corrigir' | 'adiantar' | 'revisar' | 'retestar' | 'assinatura'
export const PR_QUEUE_LABELS: Record<PrQueue, string> = {
  conflito: 'conflito com a branch principal',
  corrigir: 'respondendo a uma revisão',
  adiantar: 'análise antecipada',
  revisar: 'revisão',
  retestar: 'teste local (CI bloqueado)',
  assinatura: 'limpeza de assinatura'
}
export type PrReviewVerdict = 'approve' | 'request_changes' | 'comment'
export type FindingSeverity = 'critical' | 'warning' | 'suggestion'

export interface PrReviewCounts {
  critical: number
  warning: number
  suggestion: number
}

export interface PrReview {
  id: number
  projectId: number
  number: number
  headSha: string
  title: string
  url: string
  authorLogin: string
  queue: PrQueue
  // Quem trabalha nesta fila: o Claude e o token do GitHub dessa pessoa.
  reviewerId: number | null
  // Uma linha com o que foi feito (como a resposta final do revisor do Hermes).
  line: string | null
  // Commit enviado pelo revisor com as correções, se houve.
  pushedSha: string | null
  // Pergunta de produto achada no corpo do PR: o revisor para antes de aprovar e espera a resposta.
  question: string | null
  answer: string | null
  attempts: number
  status: PrReviewStatus
  verdict: PrReviewVerdict | null
  summary: string | null
  counts: PrReviewCounts | null
  reviewUrl: string | null
  chatId: number | null
  error: string | null
  trigger: 'auto' | 'manual'
  createdAt: string
  updatedAt: string
}

export const VERDICT_LABELS: Record<PrReviewVerdict, string> = {
  approve: 'pode seguir',
  request_changes: 'pedir mudanças',
  comment: 'comentários'
}

// Rotina (cron): o agente da pessoa roda sozinho num horário e entrega o resultado.
export type RoutineFolder = 'routine' | 'vault'
export type RoutineDeliver = 'telegram' | 'harpia'
export type RoutineRunStatus = 'running' | 'ok' | 'silent' | 'failed' | 'skipped' | 'interrupted'

export interface Routine {
  id: number
  userId: number
  name: string
  prompt: string
  // Expressão cron de 5 campos (minuto hora dia mês dia-da-semana), no fuso da rotina.
  schedule: string
  timezone: string
  // Pasta em que o agente trabalha: uma só da rotina ou o cofre da pessoa.
  folder: RoutineFolder
  // Pode buscar e ler páginas na web.
  web: boolean
  model: string | null
  deliver: RoutineDeliver
  // A execução anterior entra no contexto, para não repetir o que já foi dito.
  continuity: boolean
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: RoutineRunStatus | null
  lastError: string | null
  failureStreak: number
  holdUntil: string | null
  createdAt: string
  updatedAt: string
}

export interface RoutineRun {
  id: number
  routineId: number
  scheduledFor: string
  trigger: 'schedule' | 'manual'
  status: RoutineRunStatus
  chatId: number | null
  output: string | null
  error: string | null
  delivered: boolean
  startedAt: string
  finishedAt: string | null
}

export const ROUTINE_TIMEZONE = 'America/Sao_Paulo'

// Modelo que a conta da pessoa oferece, como o Claude Code ou o Codex informam.
export interface ChatModel {
  id: string
  label: string
  description: string
}

interface ChatItemBase {
  id: number
  chatId: number
  createdAt: string
  updatedAt: string
}

export type ChatItem = ChatItemBase &
  (
    // steer: mensagem enviada enquanto o agente trabalhava; entra no meio da vez dele.
    | { kind: 'user'; text: string; authorId: number; steer?: boolean }
    | { kind: 'assistant'; text: string; streaming: boolean }
    | { kind: 'tool'; name: string; summary: string; status: 'running' | 'done' | 'failed'; output: string | null }
    | {
        kind: 'approval'
        title: string
        detail: string
        status: 'pending' | 'allowed' | 'denied' | 'expired'
        decidedBy: number | null
      }
    | { kind: 'error'; text: string }
    // Aviso passageiro do agente, como "sem conexão, tentando de novo".
    | { kind: 'notice'; text: string }
  )

export type ChatItemKind = ChatItem['kind']

// Entrega pelo GitHub (fase 5).
export type PullRequestState = 'open' | 'merged' | 'closed'

export interface PullRequest {
  id: number
  taskId: number
  userId: number
  number: number
  url: string
  branch: string
  base: string
  state: PullRequestState
  createdAt: string
  updatedAt: string
}

// Arquivo alterado na cópia de trabalho da pessoa, em relação à branch principal.
export interface ChangedFile {
  path: string
  // A: novo, M: alterado, D: apagado, ?: ainda não versionado
  status: 'A' | 'M' | 'D' | '?'
  additions: number | null
  deletions: number | null
}

// Vigia (fase 4): avisos sobre o andamento das tasks.
export type FindingKind = 'stale' | 'review_without_pr' | 'file_overlap' | 'duplicate'

export const FINDING_LABELS: Record<FindingKind, string> = {
  stale: 'Task parada',
  review_without_pr: 'Revisão sem PR',
  file_overlap: 'Mesmos arquivos',
  duplicate: 'Tasks parecidas'
}

export interface Finding {
  id: number
  projectId: number
  kind: FindingKind
  taskIds: number[]
  userIds: number[]
  message: string
  details: Record<string, unknown>
  // resolved: o vigia viu que o problema acabou; dismissed: alguém dispensou o aviso.
  status: 'open' | 'dismissed' | 'resolved'
  dismissedBy: number | null
  createdAt: string
  updatedAt: string
}

export interface SimilarTask {
  id: number
  number: number
  title: string
  status: TaskStatus
}

// Memória do projeto: o que a equipe quer que todo agente saiba ao começar uma conversa.
export const PROJECT_MEMORY_LIMIT = 3000

export interface ProjectMemory {
  projectId: number
  body: string
  updatedBy: number | null
  updatedAt: string | null
}

export interface NotificationSettings {
  telegram: {
    // O servidor tem um bot do Telegram configurado.
    available: boolean
    botUsername: string | null
    linked: boolean
  }
}

// Mensagens enviadas pelo servidor em tempo real (WebSocket).
export type RealtimeMessage =
  | { type: 'presence'; userIds: number[] }
  | { type: 'project'; project: Project }
  | { type: 'task'; task: Task }
  | { type: 'task_event'; event: TaskEvent }
  | { type: 'user'; user: User }
  | { type: 'session'; session: AgentSession }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_item'; item: ChatItem }
  // A conversa deixou de estar visível para quem recebe (foi excluída ou deixou de ser compartilhada).
  | { type: 'chat_removed'; chatId: number }
  | { type: 'pr_review'; review: PrReview }
  | { type: 'task_summary'; summary: TaskSummary }
  | { type: 'learning'; learning: Learning }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine_removed'; routineId: number }
  | { type: 'routine_run'; run: RoutineRun }
  | { type: 'pull_request'; pullRequest: PullRequest }
  | { type: 'finding'; finding: Finding }
  | { type: 'memory'; memory: ProjectMemory }
