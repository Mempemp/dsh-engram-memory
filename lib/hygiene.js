/**
 * Гигиена памяти: что усвоено выводами, что ждёт свода, что дублируется и что
 * можно убрать из обращения.
 *
 * Плагин ничего не удаляет сам: он считает и показывает. Уборка — отдельное
 * действие человека, потому что мягко удалённая заметка пропадает из поиска, а
 * знание после этого живёт только в выводе-карточке, который на неё ссылается.
 * Строка при этом из базы не пропадает: `engram delete` без `--hard` — это
 * скрытие, а не удаление.
 */
import { CARD_TYPES, isRawRow, parseSourceIds } from './panel.js'

const marks = () => CARD_TYPES.map(() => '?').join(', ')
const lowered = () => CARD_TYPES.map((type) => String(type).toLowerCase())

/** Момент времени из строки базы: engram пишет время в разных форматах. */
function timeOf(value) {
  const stamp = Date.parse(String(value ?? ''))
  return Number.isFinite(stamp) ? stamp : null
}

/**
 * Какие заметки на какие выводы сослались: `Map<id заметки, id выводов>`.
 * Ссылку ставит плагин, поэтому разбор один — в `parseSourceIds`.
 */
export function cardsBySource(store) {
  const map = new Map()
  if (store === null) return map
  try {
    const cards = store
      .prepare(`SELECT id, content FROM observations WHERE deleted_at IS NULL AND lower(type) IN (${marks()})`)
      .all(...lowered())
    for (const card of cards) {
      for (const sourceId of parseSourceIds(card.content)) {
        const list = map.get(sourceId) ?? []
        list.push(card.id)
        map.set(sourceId, list)
      }
    }
  } catch {
    return map
  }
  return map
}

const EMPTY = {
  total: 0,
  raw: 0,
  consumed: 0,
  queued: 0,
  pinned: 0,
  shared: 0,
  removed: 0,
  duplicates: 0,
  relations: { total: 0, pending: 0, supersedes: 0, contradicts: 0, related: 0 },
  oldestQueuedAt: null,
  compactable: 0
}

/**
 * Связи между записями: engram заводит их сам и сам же разбирает — «заменяет»
 * устаревшее, «связано», «противоречит». Для гигиены важно, что уже заменено и
 * что ещё ждёт разбора: заменённое не надо перечитывать, неразобранное — надо.
 */
export function relations(store) {
  const empty = { total: 0, pending: 0, supersedes: 0, contradicts: 0, related: 0 }
  if (store === null) return empty
  let rows
  try {
    rows = store.prepare('SELECT relation, judgment_status FROM memory_relations').all()
  } catch {
    return empty
  }
  const found = { ...empty, total: rows.length }
  for (const row of rows) {
    const relation = String(row.relation ?? '').toLowerCase()
    const status = String(row.judgment_status ?? '').toLowerCase()
    if (status === 'pending' || relation === 'pending') found.pending += 1
    if (relation === 'supersedes') found.supersedes += 1
    if (relation === 'contradicts' || relation === 'conflict') found.contradicts += 1
    if (relation === 'related') found.related += 1
  }
  return found
}

/**
 * Один проход по базе: отчёт и список заметок, которые можно убрать из
 * обращения. Считается один раз и отдаётся обоим потребителям, чтобы вкладка и
 * уборка не разошлись в показаниях.
 */
function scan(store, { days = 30 } = {}) {
  if (store === null) return { report: { ...EMPTY, days }, stale: [] }
  let rows
  try {
    rows = store
      .prepare('SELECT id, title, type, scope, pinned, deleted_at, duplicate_count, updated_at FROM observations')
      .all()
  } catch {
    return { report: { ...EMPTY, days }, stale: [] }
  }
  const cited = cardsBySource(store)
  const cutoff = Date.now() - Math.max(0, days) * 86400000
  const report = { ...EMPTY, days }
  const stale = []
  for (const row of rows) {
    report.total += 1
    if (row.deleted_at != null) {
      report.removed += 1
      continue
    }
    // Помеченное вручную и общий слой считаем до фильтра: `isRawRow` их уже
    // отсекает, но в отчёте они должны быть видны — это разные причины.
    const scope = String(row.scope ?? 'project')
    const isShared = scope !== 'project'
    if (Number(row.pinned ?? 0) === 1) report.pinned += 1
    if (isShared) report.shared += 1
    // Сырое — всё, что не карточка, не помечено вручную и не удалено: то же
    // определение, что у очереди в базе.
    if (!isRawRow(row)) continue
    report.raw += 1
    if (Number(row.duplicate_count ?? 0) > 1) report.duplicates += 1
    if (isShared) continue
    const sources = cited.get(row.id)
    if (sources === undefined) {
      report.queued += 1
      const stamp = timeOf(row.updated_at)
      const oldest = timeOf(report.oldestQueuedAt)
      if (stamp !== null && (oldest === null || stamp < oldest)) report.oldestQueuedAt = row.updated_at
      continue
    }
    report.consumed += 1
    const stamp = timeOf(row.updated_at)
    if (stamp === null || stamp > cutoff) continue
    report.compactable += 1
    stale.push({ id: row.id, title: row.title, card: sources[0], cards: sources })
  }
  report.relations = relations(store)
  return { report, stale }
}

/** Сводка по базе для вкладки и команды. */
export function hygieneReport(store, options = {}) {
  return scan(store, options).report
}

/**
 * Заметки, которые можно убрать из обращения: по ним уже есть вывод-карточка,
 * они старше `days`, не помечены вручную и не лежат в общем слое. Порядок — от
 * самых старых.
 */
export function compactableNotes(store, options = {}) {
  return scan(store, options).stale.sort((left, right) => left.id - right.id)
}

/** Аргументы CLI: мягкое удаление. `--hard` здесь не бывает по замыслу. */
export function removeArgs(id) {
  return ['delete', String(id)]
}
