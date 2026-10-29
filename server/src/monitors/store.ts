import type { HealthCheck, MonitorEvent, MonitorItem, ProjectMonitor } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'
import type { DeployState } from './checks.ts'

interface MonitorRow {
  project_id: number
  enabled: number
  coolify_app_uuid: string
  health_checks: string
  timezone: string
  notify_user_ids: string
  deploy_state: string | null
  watch_state: string | null
  watching_since: string | null
  panorama: string | null
  checked_at: string | null
  updated_at: string
}

export interface StoredMonitor extends ProjectMonitor {
  deployState: DeployState | null
  watchState: Record<string, string | null> | null
  watchingSince: string | null
}

interface Panorama {
  items: MonitorItem[]
  lastDeploy: ProjectMonitor['lastDeploy']
}

function toMonitor(row: MonitorRow): StoredMonitor {
  const panorama = row.panorama ? (JSON.parse(row.panorama) as Panorama) : { items: [], lastDeploy: null }
  return {
    projectId: row.project_id,
    enabled: row.enabled === 1,
    coolifyAppUuid: row.coolify_app_uuid,
    healthChecks: JSON.parse(row.health_checks) as HealthCheck[],
    timezone: row.timezone,
    notifyUserIds: JSON.parse(row.notify_user_ids) as number[],
    panorama: panorama.items,
    lastDeploy: panorama.lastDeploy,
    checkedAt: row.checked_at,
    deployState: row.deploy_state ? (JSON.parse(row.deploy_state) as DeployState) : null,
    watchState: row.watch_state ? (JSON.parse(row.watch_state) as Record<string, string | null>) : null,
    watchingSince: row.watching_since
  }
}

export function publicMonitor(monitor: StoredMonitor): ProjectMonitor {
  const { deployState: _d, watchState: _w, watchingSince: _s, ...rest } = monitor
  return rest
}

export function emptyMonitor(projectId: number): ProjectMonitor {
  return {
    projectId,
    enabled: false,
    coolifyAppUuid: '',
    healthChecks: [],
    timezone: 'America/Sao_Paulo',
    notifyUserIds: [],
    panorama: [],
    lastDeploy: null,
    checkedAt: null
  }
}

export function getMonitor(db: Db, projectId: number): StoredMonitor | null {
  const row = db.prepare('SELECT * FROM project_monitors WHERE project_id = ?').get(projectId) as MonitorRow | undefined
  return row ? toMonitor(row) : null
}

export function listEnabledMonitors(db: Db): StoredMonitor[] {
  return (db.prepare('SELECT * FROM project_monitors WHERE enabled = 1 ORDER BY project_id').all() as unknown as MonitorRow[]).map(toMonitor)
}

// Mudar a aplicação ou ligar de novo recomeça o estado: a próxima volta manda o panorama inteiro.
export function saveMonitorConfig(
  db: Db,
  projectId: number,
  input: { enabled: boolean; coolifyAppUuid: string; healthChecks: HealthCheck[]; timezone: string; notifyUserIds: number[] },
  now: Date
): StoredMonitor {
  const current = getMonitor(db, projectId)
  const restart = !current || current.coolifyAppUuid !== input.coolifyAppUuid || (!current.enabled && input.enabled)
  db.prepare(
    `INSERT INTO project_monitors (project_id, enabled, coolify_app_uuid, health_checks, timezone, notify_user_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET enabled = excluded.enabled, coolify_app_uuid = excluded.coolify_app_uuid,
       health_checks = excluded.health_checks, timezone = excluded.timezone, notify_user_ids = excluded.notify_user_ids,
       updated_at = excluded.updated_at`
  ).run(
    projectId,
    input.enabled ? 1 : 0,
    input.coolifyAppUuid,
    JSON.stringify(input.healthChecks),
    input.timezone,
    JSON.stringify(input.notifyUserIds),
    now.toISOString()
  )
  if (restart) {
    db.prepare('UPDATE project_monitors SET deploy_state = NULL, watch_state = NULL, panorama = NULL, checked_at = NULL, watching_since = ? WHERE project_id = ?').run(
      now.toISOString(),
      projectId
    )
  }
  return getMonitor(db, projectId) as StoredMonitor
}

export function saveMonitorState(
  db: Db,
  projectId: number,
  input: { deployState: DeployState | null; watchState: Record<string, string | null>; panorama: Panorama },
  now: Date
): StoredMonitor {
  db.prepare('UPDATE project_monitors SET deploy_state = ?, watch_state = ?, panorama = ?, checked_at = ? WHERE project_id = ?').run(
    input.deployState ? JSON.stringify(input.deployState) : null,
    JSON.stringify(input.watchState),
    JSON.stringify(input.panorama),
    now.toISOString(),
    projectId
  )
  return getMonitor(db, projectId) as StoredMonitor
}

export function insertMonitorEvent(db: Db, projectId: number, text: string, now: Date): MonitorEvent {
  const result = db.prepare('INSERT INTO monitor_events (project_id, text, created_at) VALUES (?, ?, ?)').run(projectId, text, now.toISOString())
  // Guarda só os 200 avisos mais novos de cada projeto.
  db.prepare('DELETE FROM monitor_events WHERE project_id = ? AND id NOT IN (SELECT id FROM monitor_events WHERE project_id = ? ORDER BY id DESC LIMIT 200)').run(
    projectId,
    projectId
  )
  return { id: Number(result.lastInsertRowid), projectId, text, createdAt: now.toISOString() }
}

export function listMonitorEvents(db: Db, projectId: number, limit = 30): MonitorEvent[] {
  const rows = db.prepare('SELECT * FROM monitor_events WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as {
    id: number
    project_id: number
    text: string
    created_at: string
  }[]
  return rows.map((row) => ({ id: row.id, projectId: row.project_id, text: row.text, createdAt: row.created_at }))
}
