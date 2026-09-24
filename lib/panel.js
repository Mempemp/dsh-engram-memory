/**
 * Половина плагина для вкладки настроек: статистика по заметкам, запуск обработки
 * и её состояние.
 *
 * Числа считаются по базе, а не по памяти процесса: «не обработано» — это сырые
 * заметки проекта, на которые не ссылается ни одна карточка-вывод. Поэтому
 * полоска в интерфейсе честная и после перезапуска десктопа не обнуляется.
 */

/** Типы, которые считаются выводами (карточками), а не сырыми заметками. */
const CARD_TYPES = ['pattern', 'decision', 'architecture']

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
 * Статистика проекта: сколько сырых заметок, сколько из них уже сведено в выводы
 * и сколько карточек вывода лежит в памяти.
 */
export function panelStatistics(store, project) {
  const empty = { total: 0, processed: 0, unprocessed: 0, cards: 0, bar: 0 }
  if (store === null || typeof project !== 'string' || project === '') return empty
  let rows = []
  try {
    rows = store
      .prepare(
        `SELECT o.id, o.type, o.pinned, o.deleted_at, o.content
           FROM observations o
          WHERE o.project = ? COLLATE NOCASE`
      )
      .all(project)
  } catch {
    return empty
  }
  const processed = new Set()
  let cards = 0
  for (const row of rows) {
    if (!isCardRow(row)) continue
    cards += 1
    for (const id of parseSourceIds(row.content)) processed.add(id)
  }
  let total = 0
  let done = 0
  for (const row of rows) {
    if (!isRawRow(row)) continue
    total += 1
    if (processed.has(row.id)) done += 1
  }
  return {
    total,
    processed: done,
    unprocessed: total - done,
    cards,
    bar: total === 0 ? 0 : done / total
  }
}

/**
 * Какая модель обрабатывает заметки.
 *
 * Порядок не случаен: сначала явная настройка плагина, затем модель по умолчанию
 * из настроек DSH (та же, что выбирается в «Моделях»), и только в последнюю
 * очередь — модель текущей сессии. Вкладка настроек живёт вне разговора, поэтому
 * модель сессии здесь скорее запасной вариант, чем правило.
 */
export function resolveRoute({ override, defaultSelection, sessionRoute } = {}) {
  if (override && typeof override.provider === 'string' && override.provider !== '' && typeof override.model === 'string' && override.model !== '') {
    return override
  }
  if (defaultSelection && typeof defaultSelection.provider === 'string' && typeof defaultSelection.model === 'string') {
    return defaultSelection
  }
  if (sessionRoute && typeof sessionRoute.provider === 'string' && typeof sessionRoute.model === 'string') {
    return sessionRoute
  }
  return undefined
}

/**
 * Один проход обработки в любой момент времени: интерфейс опрашивает состояние,
 * а не держит запрос открытым, — обработка ждёт модель и может идти минуту.
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
    model: null
  }
  let controller = null

  const status = () => ({ ...state })

  const start = async () => {
    if (state.running) return { started: false, reason: 'уже идёт обработка', status: status() }
    controller = new AbortController()
    state = { ...state, running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null, report: null }
    try {
      const result = await run(controller.signal)
      state = {
        ...state,
        ok: result.status === 'ok',
        report: result.report ?? null,
        notes: result.notes ?? 0,
        cards: result.cards ?? 0,
        saved: result.saved ?? [],
        tokens: result.usage?.totalTokens ?? null,
        model: result.model ?? null,
        error: result.status === 'ok' ? null : (result.error ?? 'обрабатывать было нечего')
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
