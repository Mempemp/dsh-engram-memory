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
 * Тот же необязательный конфиг, что читает шим MCP-сервера
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
 */
export function searchObservations(store, { query, project, limit = 5 } = {}) {
  const match = buildMatchQuery(query)
  if (match === null || store === null) return []
  const where = ['observations_fts MATCH ?', 'o.deleted_at IS NULL']
  const params = [match]
  if (typeof project === 'string' && project !== '') {
    where.push('o.project = ?')
    params.push(project)
  }
  params.push(limit)
  try {
    return store
      .prepare(
        `SELECT o.id, o.title, o.content, o.project, o.type, o.pinned, o.updated_at,
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

/** Первая содержательная строка записи: в инъекцию идёт она, не весь текст. */
export function firstLine(content, max = 280) {
  const line = String(content ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Собирает текст инъекции в жёстком бюджете символов.
 *
 * Записи сверх бюджета отбрасываются целиком, а не обрезаются: обрубок
 * заголовка стоит токенов и не даёт ответа. Пустой результат — тоже результат.
 */
export function formatInjection(rows, { budget = 1200, topK = 2, header = 'Память проекта (engram), возможно релевантное:' } = {}) {
  const picked = []
  let used = header.length + 1
  for (const row of rows.slice(0, topK)) {
    const line = `- [${row.id}] ${row.title}${row.content ? ` — ${firstLine(row.content)}` : ''}`
    if (used + line.length + 1 > budget) break
    used += line.length + 1
    picked.push(line)
  }
  if (picked.length === 0) return null
  return `${header}\n${picked.join('\n')}`
}
