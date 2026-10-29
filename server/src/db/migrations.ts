import type { DatabaseSync } from 'node:sqlite'

// Cada item é uma versão do banco. Nunca edite uma migração já publicada:
// acrescente uma nova no fim da lista.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by INTEGER REFERENCES users(id),
    used_at TEXT
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    repo_url TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    clone_status TEXT NOT NULL CHECK (clone_status IN ('pending', 'cloning', 'ready', 'error')),
    clone_error TEXT,
    next_task_number INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('backlog', 'in_progress', 'review', 'done')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    position REAL NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (project_id, number)
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, status, position);

  CREATE TABLE task_participants (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );

  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_task_events_task ON task_events(task_id, id);
  `,
  // Fase 3: cópia de trabalho de cada pessoa por task e sessões dos agentes.
  `
  CREATE TABLE task_worktrees (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );

  CREATE TABLE agent_sessions (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('claude', 'codex', 'shell', 'account')),
    branch TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'exited')),
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX idx_agent_sessions_task ON agent_sessions(task_id, id);
  CREATE INDEX idx_agent_sessions_user ON agent_sessions(user_id, status);
  `,
  // Conversas com os agentes (chat).
  `
  CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'closed')),
    permission_mode TEXT NOT NULL CHECK (permission_mode IN ('ask', 'edits', 'auto')),
    provider_session_id TEXT,
    branch TEXT,
    cwd TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_chats_task ON chats(task_id, id);

  CREATE TABLE chat_items (
    id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_chat_items_chat ON chat_items(chat_id, id);
  `,
  // Pull requests abertos pelo Harpia.
  `
  CREATE TABLE pull_requests (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    base TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_pull_requests_task ON pull_requests(task_id);
  CREATE INDEX idx_pull_requests_state ON pull_requests(state);
  `,
  // Fase 4: vigia, memória do projeto, avisos e busca de texto nas tasks.
  `
  CREATE TABLE watcher_findings (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    task_ids TEXT NOT NULL,
    user_ids TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('open', 'dismissed', 'resolved')),
    dismissed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_findings_project ON watcher_findings(project_id, status);

  CREATE TABLE project_memories (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE notification_targets (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, platform)
  );

  CREATE TABLE notification_link_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE tasks_fts USING fts5(
    title, description, content='tasks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
    INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
  END;
  CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  END;
  CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
    INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
  END;
  INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild');
  `,
  // Sugestão da próxima mensagem em cada conversa.
  `
  ALTER TABLE chats ADD COLUMN suggestion TEXT;
  `,
  // Fase 2: conversas fora das tasks (privadas ou compartilhadas) e escolha do modelo.
  `
  ALTER TABLE chats ADD COLUMN model TEXT;
  ALTER TABLE chats ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_chats_user ON chats(user_id, task_id);
  `,
  // Fase 6: rotinas (cron), revisão automática de PRs e o agente pessoal do Telegram com o cofre.
  `
  ALTER TABLE chats ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
  ALTER TABLE chats ADD COLUMN policy TEXT;
  ALTER TABLE chats ADD COLUMN instructions TEXT;

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE routines (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    timezone TEXT NOT NULL,
    folder TEXT NOT NULL CHECK (folder IN ('routine', 'vault')),
    web INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    deliver TEXT NOT NULL CHECK (deliver IN ('telegram', 'harpia')),
    continuity INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    cwd TEXT NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    failure_streak INTEGER NOT NULL DEFAULT 0,
    hold_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE INDEX idx_routines_due ON routines(enabled, next_run_at);

  CREATE TABLE routine_runs (
    id INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'silent', 'failed', 'skipped', 'interrupted')),
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    output TEXT,
    error TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  -- Cada horário agendado roda no máximo uma vez.
  CREATE UNIQUE INDEX idx_routine_runs_slot ON routine_runs(routine_id, scheduled_for) WHERE trigger = 'schedule';
  CREATE INDEX idx_routine_runs_routine ON routine_runs(routine_id, id);
  `,
  // Fase 6: revisão automática dos PRs no GitHub, no Claude do autor de cada PR.
  `
  ALTER TABLE users ADD COLUMN github_login TEXT;
  CREATE UNIQUE INDEX idx_users_github_login ON users(lower(github_login)) WHERE github_login IS NOT NULL;
  ALTER TABLE projects ADD COLUMN pr_review INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE pr_reviews (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    author_login TEXT NOT NULL,
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'posted', 'failed', 'skipped')),
    verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment')),
    summary TEXT,
    counts TEXT,
    review_url TEXT,
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    error TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, number, head_sha)
  );
  CREATE INDEX idx_pr_reviews_project ON pr_reviews(project_id, id);
  `,
  // Fase 6: o que chega pelo Telegram e é guardado no cofre de cada pessoa (sem repetir).
  `
  CREATE TABLE vault_items (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'link', 'photo', 'document', 'voice', 'audio', 'video')),
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, source_ref)
  );
  CREATE INDEX idx_vault_items_user ON vault_items(user_id, id);
  `,
  // Fase 4b: o vigia com IA (no Claude de quem está envolvido): tasks parecidas confirmadas,
  // resumo das tasks concluídas, aprendizados para o AGENTS.md e sugestões no Codex.
  `
  CREATE TABLE task_summaries (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE learnings (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (target IN ('agents_md', 'memory')),
    text TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'dismissed')),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pr_url TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX idx_learnings_project ON learnings(project_id, status);
  CREATE INDEX idx_learnings_task ON learnings(task_id);

  CREATE TABLE ai_judgments (
    fingerprint TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('duplicate', 'different', 'error')),
    reason TEXT,
    created_at TEXT NOT NULL
  );

  ALTER TABLE users ADD COLUMN codex_suggestions INTEGER NOT NULL DEFAULT 1;
  `,
  // Revisor v2 (como o revisor do Hermes): token do GitHub de cada sócio, filas por PR,
  // revisões publicadas pelo Harpia, memória de achados por PR e lições do projeto.
  `
  CREATE TABLE github_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    login TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE users ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE users ADD COLUMN preferred_reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN default_reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN review_since TEXT;
  ALTER TABLE projects ADD COLUMN review_rules TEXT NOT NULL DEFAULT '';
  UPDATE projects SET review_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE pr_review = 1;

  CREATE TABLE pr_jobs (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    queue TEXT NOT NULL CHECK (queue IN ('conflito', 'corrigir', 'adiantar', 'revisar', 'retestar', 'assinatura')),
    trigger_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    author_login TEXT NOT NULL,
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'posted', 'failed', 'skipped')),
    verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment')),
    summary TEXT,
    counts TEXT,
    review_url TEXT,
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    error TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
    line TEXT,
    pushed_sha TEXT,
    question TEXT,
    answer TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, number, queue, trigger_key)
  );
  INSERT INTO pr_jobs (id, project_id, number, queue, trigger_key, head_sha, title, url, author_login, reviewer_id, status,
                       verdict, summary, counts, review_url, chat_id, error, trigger, created_at, updated_at)
    SELECT id, project_id, number, 'revisar', head_sha, head_sha, title, url, author_login, reviewer_id, status,
           verdict, summary, counts, review_url, chat_id, error, trigger, created_at, updated_at FROM pr_reviews;
  DROP TABLE pr_reviews;
  CREATE INDEX idx_pr_jobs_project ON pr_jobs(project_id, id);
  CREATE INDEX idx_pr_jobs_waiting ON pr_jobs(status, reviewer_id);

  -- Revisões que o próprio Harpia publicou: as outras são de pessoas (fila "corrigir").
  CREATE TABLE pr_published (
    github_review_id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    job_id INTEGER REFERENCES pr_jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  -- Memória por achado de cada PR (mesmo formato do revisor_memoria.py do Hermes).
  CREATE TABLE pr_memories (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, number)
  );

  -- Estado por PR: revisor já pedido no GitHub uma vez, e rascunho posto pelo próprio revisor.
  CREATE TABLE pr_flags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    reviewer_requested INTEGER NOT NULL DEFAULT 0,
    drafted_by_reviewer INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, number)
  );

  -- Lições que valem para outras PRs (append-only, como o licoes.md do Hermes).
  CREATE TABLE review_lessons (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER,
    author_login TEXT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 13: vigias do deploy e das tarefas agendadas do Coolify, por projeto (port dos vigias do Hermes).
  `
  CREATE TABLE project_monitors (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    coolify_app_uuid TEXT NOT NULL DEFAULT '',
    health_checks TEXT NOT NULL DEFAULT '[]',
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    notify_user_ids TEXT NOT NULL DEFAULT '[]',
    -- Estado de cada vigia entre as voltas (como os arquivos de estado dos scripts do Hermes).
    deploy_state TEXT,
    watch_state TEXT,
    watching_since TEXT,
    panorama TEXT,
    checked_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE monitor_events (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX monitor_events_project ON monitor_events(project_id, id);
  `,
  // 14: tasks importadas de outro quadro: o código delas lá (ex.: J15) e uma impressão digital do
  // cartão, para reimportar sem duplicar nem desfazer o que a equipe mudou no Harpia.
  `
  ALTER TABLE tasks ADD COLUMN external_id TEXT;
  ALTER TABLE tasks ADD COLUMN external_hash TEXT;
  CREATE UNIQUE INDEX tasks_external ON tasks(project_id, external_id) WHERE external_id IS NOT NULL;
  `
]

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
