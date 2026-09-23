// Фикстура engram-совместимой базы: та же схема, что у настоящего engram v2.0.0,
// чтобы тесты не зависели от наличия бинарника.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Колонки observations из настоящей engram.db (проверено на v2.0.0). */
const OBSERVATION_COLUMNS =
  'id INTEGER PRIMARY KEY, sync_id TEXT, session_id TEXT, type TEXT, title TEXT, content TEXT, tool_name TEXT, ' +
  'project TEXT, scope TEXT, topic_key TEXT, normalized_hash TEXT, revision_count INTEGER, duplicate_count INTEGER, ' +
  'last_seen_at TEXT, pinned BOOLEAN, created_at TEXT, updated_at TEXT, deleted_at TEXT, review_after TEXT, ' +
  'expires_at TEXT, embedding BLOB, embedding_model TEXT, embedding_created_at TEXT'

export function createStore(rows, { dir = mkdtempSync(join(tmpdir(), 'engram-fixture-')), sessions = [] } = {}) {
  const path = join(dir, 'engram.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE observations (${OBSERVATION_COLUMNS})`)
  db.exec(
    'CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, tool_name, type, project, topic_key, ' +
      "content='observations', content_rowid='id')"
  )
  db.exec('CREATE TABLE sessions (id TEXT, project TEXT, directory TEXT, started_at TEXT, ended_at TEXT, summary TEXT)')
  const insert = db.prepare(
    'INSERT INTO observations (title, content, project, scope, type, created_at, updated_at, pinned) ' +
      "VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)"
  )
  for (const row of rows) {
    insert.run(row.title, row.content, row.project ?? 'demo', row.scope ?? 'project', row.type ?? 'discovery')
  }
  const insertSession = db.prepare('INSERT INTO sessions (id, project, directory, started_at) VALUES (?, ?, ?, ?)')
  for (const session of sessions) {
    insertSession.run(session.id, session.project, session.directory, session.started_at ?? '2026-09-23 00:00:00')
  }
  // Триггеры engram держат FTS в актуальном состоянии; здесь достаточно ручного rebuild.
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")
  db.close()
  return { dir, path }
}

export function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true })
}
