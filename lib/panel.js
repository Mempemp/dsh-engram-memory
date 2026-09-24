/**
 * Половина плагина для вкладки настроек: статистика по заметкам, запуск обработки
 * и её состояние.
 *
 * Числа считаются по базе, а не по памяти процесса: «не обработано» — это сырые
 * заметки проекта, на которые не ссылается ни одна карточка-вывод. Поэтому
 * полоска в интерфейсе честная и после перезапуска десктопа не обнуляется.
 */

/** Типы, которые считаются выводами (карточками), а не сырыми заметками. */
export const CARD_TYPES = ['pattern', 'decision', 'architecture']

/**
 * Идентификаторы заметок, на которые ссылается карточка. Ссылку ставит плагин
 * при записи (`Источники: #12, #15`), поэтому она есть в теле записи.
 */
export function parseSourceIds(content) {
  const ids = new Set()
  const text = String(content ?? '')
  const line = text.match(/Источники:\s*([^\n]*)/)
  if (line === null) return ids
  for (const match of line[1].matchAll(/#(\d+)/g)) ids.add(Number(match[1]))
  return ids
}

export function isCardRow(row, types = CARD_TYPES) {
  return types.includes(String(row?.type ?? '').toLowerCase()) && row?.deleted_at == null
}

export function isRawRow(row, types = CARD_TYPES) {
  return !types.includes(String(row?.type ?? '').toLowerCase()) && row?.deleted_at == null && row?.pinned !== 1
}

/**
 * Идентификаторы заметок, на которые уже ссылается хоть одна карточка-вывод.
 *
 * Идентификаторы в базе сквозные, поэтому «сведено» — свойство самой заметки, а
 * не проекта: карточка общего слоя ссылается на заметки разных проектов, и
 * считать их необработанными в своём проекте было бы неправдой.
 */
export function processedIds(store) {
  const done = new Set()
  if (store === null) return done
  let rows = []
  try {
    rows = store.prepare('SELECT id, type, pinned, deleted_at, content FROM observations WHERE deleted_at IS NULL').all()
  } catch {
    return done
  }
  for (const row of rows) {
    if (!isCardRow(row)) continue
    for (const id of parseSourceIds(row.content)) done.add(id)
  }
  return done
}

/**
 * Имена проектов, о которых в базе есть записи. Список берётся из базы, а не из
 * открытых воркспейсов: иначе невидимым остаётся всё, что накопилось в закрытых.
 */
export function listProjects(store) {
  if (store === null) return []
  try {
    return store
      .prepare(
        "SELECT DISTINCT project FROM observations WHERE deleted_at IS NULL AND project IS NOT NULL AND project <> '' ORDER BY project COLLATE NOCASE"
      )
      .all()
      .map((row) => String(row.project))
  } catch {
    return []
  }
}

/**
 * Сколько сырых заметок, сколько из них сведено в выводы и сколько карточек
 * лежит в памяти — всего и по каждому проекту.
 *
 * Числа считаются по базе, а не по памяти процесса: «не обработано» — это сырые
 * заметки, на которые не ссылается ни одна карточка. Поэтому полоска честная и
 * после перезапуска десктопа не обнуляется.
 *
 * `projects: null` — все проекты базы; массив — ровно перечисленные.
 */
export function scopeStatistics(store, { projects = null } = {}) {
  const empty = { total: 0, processed: 0, unprocessed: 0, cards: 0, bar: 0, projects: [] }
  if (store === null) return empty
  const wanted = Array.isArray(projects)
    ? projects.filter((name) => typeof name === 'string' && name !== '')
    : listProjects(store)
  const wantedLower = new Set(wanted.map((name) => name.toLowerCase()))
  let rows = []
  try {
    rows = store.prepare('SELECT id, project, type, pinned, deleted_at, content FROM observations WHERE deleted_at IS NULL').all()
  } catch {
    return empty
  }
  const done = processedIds(store)
  const buckets = new Map()
  for (const name of wanted) buckets.set(name.toLowerCase(), { project: name, total: 0, processed: 0, unprocessed: 0, cards: 0 })
  let cards = 0
  for (const row of rows) {
    const bucket = buckets.get(String(row.project ?? '').toLowerCase())
    if (bucket === undefined) continue
    if (isCardRow(row)) {
      bucket.cards += 1
      cards += 1
      continue
    }
    if (!isRawRow(row)) continue
    bucket.total += 1
    if (done.has(row.id)) bucket.processed += 1
    else bucket.unprocessed += 1
  }
  const list = [...buckets.values()].map((bucket) => ({
    ...bucket,
    bar: bucket.total === 0 ? 0 : bucket.processed / bucket.total
  }))
  const total = list.reduce((sum, bucket) => sum + bucket.total, 0)
  const processed = list.reduce((sum, bucket) => sum + bucket.processed, 0)
  return {
    total,
    processed,
    unprocessed: total - processed,
    cards,
    bar: total === 0 ? 0 : processed / total,
    projects: list
  }
}

/**
 * Какая модель обрабатывает заметки.
 *
 * Порядок не случаен: сначала явная настройка плагина, затем модель по умолчанию
 * из настроек DSH (та же, что выбирается в «Моделях»). Модель разговора здесь не
 * рассматривается вовсе: вкладка и команда живут вне сессии, и «возьмём модель
 * последнего хода» — невидимый выбор, который потом нечем объяснить.
 */
export function resolveRoute({ override, defaultSelection } = {}) {
  const filled = (route) =>
    route !== null && route !== undefined && typeof route.provider === 'string' && route.provider !== '' && typeof route.model === 'string' && route.model !== ''
  if (filled(override)) return override
  if (filled(defaultSelection)) return defaultSelection
  return undefined
}

/**
 * Один проход обработки в любой момент времени: интерфейс опрашивает состояние,
 * а не держит запрос открытым, — обработка ждёт модель и может идти минуту.
 *
 * Проход сообщает о себе через `report`: интерфейс видит «проход 2 из 3,
 * обработано 34 из 87», пока модель ещё думает.
 */
export function createJob(run, { log = () => {} } = {}) {
  let state = {
    running: false,
    startedAt: null,
    finishedAt: null,
    ok: null,
    error: null,
    report: null,
    notes: 0,
    cards: 0,
    saved: [],
    tokens: null,
    model: null,
    progress: null,
    stopped: null
  }
  let controller = null

  const status = () => ({ ...state })

  const start = async (...args) => {
    if (state.running) return { started: false, reason: 'уже идёт обработка', status: status() }
    controller = new AbortController()
    state = {
      ...state,
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      error: null,
      report: null,
      progress: null,
      stopped: null
    }
    const report = (patch) => {
      if (!state.running) return
      state = { ...state, progress: { ...(state.progress ?? {}), ...patch } }
    }
    try {
      const result = await run(controller.signal, report, ...args)
      state = {
        ...state,
        ok: result.status === 'ok',
        report: result.report ?? null,
        notes: result.notes ?? 0,
        cards: Array.isArray(result.cards) ? result.cards.length : (result.cards ?? 0),
        saved: result.saved ?? [],
        tokens: result.usage?.totalTokens ?? null,
        model: result.model ?? null,
        stopped: result.stopped ?? null,
        error: result.status === 'ok' ? null : (result.error ?? describeStop(result))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`обработка заметок не удалась: ${message}`)
      state = { ...state, ok: false, error: message }
    } finally {
      state = { ...state, running: false, finishedAt: new Date().toISOString() }
      controller = null
    }
    return { started: true, status: status() }
  }

  const cancel = () => {
    if (controller === null) return { cancelled: false, status: status() }
    controller.abort(new Error('обработка отменена'))
    return { cancelled: true, status: status() }
  }

  return { status, start, cancel }
}

/** Почему проход закончился не «ok»: у каждого исхода свой текст для интерфейса. */
function describeStop(result) {
  if (result.status === 'cancelled') return 'обработка отменена'
  if (result.status === 'no-cards') return 'модель не предложила ни одной карточки'
  if (result.status === 'model-failed') return result.error ?? 'модель не ответила'
  return 'обрабатывать было нечего'
}

/** Ответ маршрута: всегда JSON, всегда с явным признаком ошибки. */
export function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Обработчик чтения состояния вкладки. Провайдер состояния приходит снаружи —
 * так маршрут проверяется без десктопа.
 */
export function stateHandler(provider) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      sendJson(res, 200, { ok: true, ...(await provider(url.searchParams)) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
