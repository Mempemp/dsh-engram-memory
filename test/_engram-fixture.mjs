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

export function createStore(rows, { dir = mkdtempSync(join(tmpdir(), 'engram-fixture-')) } = {}) {
  const path = join(dir, 'engram.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE observations (${OBSERVATION_COLUMNS})`)
  db.exec(
    'CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, tool_name, type, project, topic_key, ' +
      "content='observations', content_rowid='id')"
  )
  const insert = db.prepare(
    'INSERT INTO observations (title, content, project, type, created_at, updated_at, pinned) ' +
      "VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 0)"
  )
  for (const row of rows) insert.run(row.title, row.content, row.project ?? 'demo', row.type ?? 'discovery')
  // Триггеры engram держат FTS в актуальном состоянии; здесь достаточно ручного rebuild.
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")
  db.close()
  return { dir, path }
}

export function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true })
}
