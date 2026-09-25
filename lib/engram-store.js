// Чтение памяти engram напрямую из её SQLite: FTS5 поверх observations.
//
// Зачем своя инъекция, если есть MCP-инструменты: инструменты вызываются моделью,
// а модель про память вспоминает не всегда. pre-step-инъекция закрывает этот случай
// и не тратит контекст впустую: запрос строится из последнего сообщения
// пользователя, бюджет жёсткий, при промахе не инжектится ничего.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Каталог данных engram по умолчанию: тот же стор, что у CLI и MCP-сервера. */
export function dataDir() {
  const fromEnv = process.env.ENGRAM_DATA_DIR
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.engram')
}

/**
 * Тот же необязательный конфиг, что читает прокладка MCP-сервера
 * (`vendor/engram-mcp/bin/engram-mcp.js`): путь к данным и проект задаются в одном месте.
 */
export function readSharedConfig() {
  const candidates = [
    process.env.ENGRAM_MCP_CONFIG,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH-1C', 'engram-mcp.json') : undefined
  ].filter((path) => typeof path === 'string' && path !== '')
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

export function databasePath(config = readSharedConfig()) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return join(config.dataDir, 'engram.db')
  return join(dataDir(), 'engram.db')
}

/** Открывает базу только на чтение: писать сюда должен только engram. */
export function openStore(path = databasePath()) {
  if (!existsSync(path)) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

const STOP_WORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так', 'его', 'но', 'да',
  'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет',
  'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был',
  'него', 'до', 'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может',
  'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была', 'сам', 'чтоб', 'без',
  'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого',
  'какой', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'были', 'куда', 'зачем',
  'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после', 'над', 'больше', 'тот',
  'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много', 'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо',
  'свою', 'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно',
  'всю', 'между', 'почему', 'скажи', 'сделай', 'нужно', 'надо', 'давай', 'покажи',
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'with', 'is', 'are', 'was', 'were', 'how', 'what', 'why', 'when',
  'and', 'or', 'not', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'be', 'can', 'we', 'you', 'i', 'do', 'does'
])

/**
 * Слова запроса в форму, которую понимает FTS5.
 *
 * Русской морфологии в engram нет, поэтому каждое слово уходит префиксом
 * (хранимое «Диаризация» находится по `диариз*`), а длинные слова — ещё и
 * усечёнными на два знака (`диаризации` → `диаризаци*`), что ловит падежи.
 * Возвращает `null`, если от запроса не осталось ничего осмысленного.
 */
export function buildMatchQuery(text, { maxTerms = 6, minLength = 3 } = {}) {
  if (typeof text !== 'string' || text === '') return null
  const terms = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const token = raw.replace(/^[-_]+|[-_]+$/g, '')
    if (token.length < minLength) continue
    if (STOP_WORDS.has(token)) continue
    if (terms.includes(token)) continue
    terms.push(token)
    if (terms.length >= maxTerms) break
  }
  if (terms.length === 0) return null
  const parts = []
  for (const term of terms) {
    parts.push(`"${term}"*`)
    if (term.length > 6) parts.push(`"${term.slice(0, -2)}"*`)
  }
  return parts.join(' OR ')
}

/**
 * Ищет записи памяти по запросу. Порядок — по BM25; мягко удалённые и чужие
 * проекты отбрасываются здесь же, чтобы вызывающий код не думал о схеме.
 *
 * Записи уровня `personal`/`global` не принадлежат проекту — они и попадают
 * в выдачу любого воркспейса; чужие проектные записи не попадают никогда.
 */
export function searchObservations(store, { query, project, limit = 5, includeShared = true } = {}) {
  const match = buildMatchQuery(query)
  if (match === null || store === null) return []
  // engram хранит имя проекта в нижнем регистре (`PixerArtist` → `pixerartist`),
  // а рабочий каталог приходит как есть: сравнивать надо без учёта регистра.
  const where = ['observations_fts MATCH ?', 'o.deleted_at IS NULL']
  const params = [match]
  if (typeof project === 'string' && project !== '') {
    if (includeShared) {
      where.push(
        "((o.project = ? COLLATE NOCASE AND COALESCE(o.scope, 'project') = 'project')" +
          " OR o.scope IN ('personal', 'global'))"
      )
    } else {
      where.push('o.project = ? COLLATE NOCASE')
    }
    params.push(project)
  }
  params.push(limit)
  try {
    return store
      .prepare(
        `SELECT o.id, o.title, o.content, o.project, o.scope, o.type, o.pinned, o.updated_at, o.revision_count,
                bm25(observations_fts) AS rank
           FROM observations_fts
           JOIN observations o ON o.id = observations_fts.rowid
          WHERE ${where.join(' AND ')}
          ORDER BY rank
          LIMIT ?`
      )
      .all(...params)
  } catch {
    return []
  }
}

/**
 * Имя проекта по каталогу воркспейса: как его назвал сам engram.
 *
 * Инструменты MCP делят проекты по своему рабочему каталогу (у сервера это
 * каталог запуска приложения, не воркспейс), поэтому запись обзора проекта
 * может лежать под именем, которое с именем папки не совпадает. Сессии в
 * engram хранят каталог, по которому проект и находится.
 */
export function projectFromSessions(store, directory) {
  if (store === null || typeof directory !== 'string' || directory === '') return null
  try {
    const row = store
      .prepare('SELECT project FROM sessions WHERE directory = ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1')
      .get(directory)
    const project = row?.project
    return typeof project === 'string' && project !== '' ? project : null
  } catch {
    return null
  }
}

/**
 * Отбирает записи для инъекции: одно место держим за общим слоем.
 *
 * Записи `personal`/`global` — правила работы, они нужнее проектных фактов,
 * поэтому попадают в ход даже если по рангу проигрывают. Остальные места
 * добираются обычным порядком (BM25).
 */
export function pickInjectionRows(rows, topK = 2) {
  const list = Array.isArray(rows) ? rows : []
  const isShared = (row) => row.scope === 'personal' || row.scope === 'global'
  const picked = []
  const shared = list.find(isShared)
  const own = list.find((row) => !isShared(row))
  if (shared !== undefined) picked.push(shared)
  if (own !== undefined) picked.push(own)
  for (const row of list) {
    if (picked.length >= topK) break
    if (!picked.includes(row)) picked.push(row)
  }
  return picked.slice(0, Math.max(1, topK))
}

/** Первая содержательная строка записи: в инъекцию идёт она, не весь текст. */
export function firstLine(content, max = 280) {
  const line = String(content ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Что показать после заголовка в инъекции: у записей, собранных плагином,
 * первая строка — «Запрос: …», и она отвечает не на тот вопрос. Если в записи
 * есть «Итог:», берём его — модель видит, что именно сделали.
 */
export function summaryLine(content, max = 280) {
  const text = String(content ?? '')
  const outcome = text.split(/\r?\n/).find((part) => part.trim().startsWith('Итог:'))
  if (outcome !== undefined) {
    const cleaned = outcome.trim().replace(/^Итог:\s*/, '')
    if (cleaned !== '') return firstLine(cleaned, max)
  }
  return firstLine(text, max)
}

/**
 * Собирает текст инъекции в жёстком бюджете символов.
 *
 * Записи сверх бюджета отбрасываются целиком, а не обрезаются: обрубок
 * заголовка стоит токенов и не даёт ответа. Пустой результат — тоже результат.
 */
export function formatInjection(
  rows,
  { budget = 1200, topK = 2, header = 'Память проекта (engram), возможно релевантное:', cue = true, cueMinRevisions = 3 } = {}
) {
  const picked = []
  const lines = []
  let used = header.length + 1
  for (const row of rows.slice(0, topK)) {
    const shared = row.scope === 'personal' || row.scope === 'global'
    const line = `- [${row.id}${shared ? '·общее' : ''}] ${row.title}${row.content ? ` — ${summaryLine(row.content)}` : ''}`
    if (used + line.length + 1 > budget) break
    used += line.length + 1
    picked.push(row)
    lines.push(line)
  }
  if (lines.length === 0) return null
  // Тема, которую запись обновляла много раз, — это работа, которая тянется.
  // Модель выводит её итог сама, но обобщение короче хроники, и напомнить об
  // этом дешевле, чем потом искать вывод среди заметок ходов.
  const ripe = cue ? picked.find((row) => Number(row.revision_count) >= cueMinRevisions) : undefined
  if (ripe !== undefined) {
    const hint =
      `- [${ripe.id}] эту тему обновляли ${ripe.revision_count} раз: если работа закончена, ` +
      'сохрани вывод одной записью (`mem_save` с тем же `topic_key`, тип `pattern`) вместо новой заметки.'
    if (used + hint.length + 1 <= budget) lines.push(hint)
  }
  return `${header}\n${lines.join('\n')}`
}
