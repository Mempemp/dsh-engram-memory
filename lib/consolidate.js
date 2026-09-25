/**
 * Обобщение (консолидация) памяти: сырые заметки ходов сводятся в карточки-выводы.
 *
 * Разделение обязанностей здесь важнее кода: заметки собирает и пишет плагин
 * (детерминированно, без модели), а сам вывод формулирует модель — она одна
 * знает, что в работе было существенным. Ссылки на источники проставляет плагин
 * по идентификаторам, которые вернула модель: «Источники: #12, #15» — это не
 * украшение, а страховка от потери точности при сжатии.
 *
 * Обработка идёт по всем проектам базы сразу, порциями: одно нажатие закрывает
 * всё, а размер запроса к модели не растёт с числом проектов. Проект — это адрес
 * записи, а не режим: карточка ложится туда же, где лежат её источники, а
 * видимость определяет `scope`.
 */
import { CARD_TYPES, isRawRow, listProjects, processedIds, scopeStatistics } from './panel.js'
import { narrowNote } from './capture.js'

/** Слои, которые видно во всех проектах: их надо заслужить источниками. */
const SHARED_SCOPES = ['global', 'personal']

/**
 * Кандидаты одного проекта: сырые заметки свежие сверху.
 *
 * Сырая заметка — всё, что не карточка-вывод: и хроника ходов (`discovery`), и
 * любой другой тип, каким его назвал пользователь (`captureType`) или модель
 * через инструменты. Типы карточек перечислены явно, поэтому новый тип заметок
 * не требует правок здесь.
 */
function projectCandidates(store, project, { limit = 20 } = {}) {
  const marks = CARD_TYPES.map(() => '?').join(', ')
  try {
    return store
      .prepare(
        `SELECT o.id, o.title, o.content, o.topic_key, o.type, o.scope, o.project, o.pinned, o.deleted_at, o.updated_at
           FROM observations o
          WHERE o.project = ? COLLATE NOCASE
            AND o.deleted_at IS NULL
            AND lower(o.type) NOT IN (${marks})
            AND COALESCE(o.pinned, 0) <> 1
          ORDER BY o.updated_at DESC, o.id DESC
          LIMIT ?`
      )
      .all(
        project,
        ...CARD_TYPES.map((type) => String(type).toLowerCase()),
        Math.max(1, limit * 4)
      )
  } catch {
    return []
  }
}

/**
 * Имена проектов для подборки: `projects` — массив (ровно перечисленные), иначе
 * одиночный `project`, иначе все проекты базы.
 */
function scopeNames(store, project, projects) {
  if (Array.isArray(projects)) return projects.filter((name) => typeof name === 'string' && name !== '')
  if (project !== undefined) return typeof project === 'string' && project !== '' ? [project] : []
  return listProjects(store)
}

/**
 * Сырые заметки для обобщения: свежие сверху, без выводов, помеченных и мягко
 * удалённых, без уже сведённых в карточки (если не попросили иначе).
 *
 * Заметки берутся по кругу — по одной от каждого проекта: в одной порции должны
 * быть видны разные проекты, иначе вывод в общий слой было бы не из чего сделать.
 * Упирается в два предела сразу — число заметок и общий размер текста: длинная
 * подборка съедает контекст модели.
 */
export function collectNotes(store, { project, projects, limit = 20, maxChars = 12000, skipProcessed = true } = {}) {
  if (store === null) return []
  const names = scopeNames(store, project, projects)
  if (names.length === 0) return []
  const done = skipProcessed ? processedIds(store) : new Set()
  const pools = []
  for (const name of names) {
    const fresh = projectCandidates(store, name, { limit }).filter((row) => isRawRow(row) && !done.has(row.id))
    if (fresh.length > 0) pools.push({ rows: fresh.slice(0, Math.max(1, limit)), index: 0 })
  }
  const notes = []
  let used = 0
  let taken = true
  while (taken && notes.length < limit) {
    taken = false
    for (const pool of pools) {
      if (notes.length >= limit) break
      const note = pool.rows[pool.index]
      if (note === undefined) continue
      const content = String(note.content ?? '')
      // Заметка сверх бюджета отбрасывается целиком; одиночную берём — иначе
      // проект, где все заметки длинные, не обрабатывался бы никогда.
      if (used + content.length > maxChars && notes.length > 0) return notes
      pool.index += 1
      used += content.length
      notes.push(note)
      taken = true
    }
  }
  return notes
}

/**
 * Текст одной заметки для подсказки модели: идентификатор, по которому потом
 * сошлются, и проект, из которого заметка пришла, — по нему модель и решает,
 * тянет ли вывод на общий слой.
 *
 * Тело заметки идёт срезом (`narrowNote`): запрос и ключи целиком, проза —
 * началом и концом. Иначе один длинный ответ съедал бы половину прохода, и
 * цена обобщения росла бы вместе с длиной ответов.
 */
function noteBlock(note, noteChars) {
  const topic = note.topic_key ? ` тема=${note.topic_key}` : ''
  const project = typeof note.project === 'string' && note.project !== '' ? ` проект=${note.project}` : ''
  const body = narrowNote(String(note.content ?? '').trim(), noteChars)
  return `#${note.id} [${note.type}${project}${topic}] ${note.title}\n${body}`
}

const SYSTEM = [
  'Ты сводишь сырые заметки о проделанной работе в карточки-выводы для долговременной памяти.',
  'Твоя задача — не пересказать заметки, а сформулировать знание: что теперь известно и как это делать в следующий раз.',
  'Отвечай только JSON-массивом, без пояснений и без markdown-обёртки.'
].join(' ')

const INSTRUCTION = [
  'Ниже сырые заметки ходов с идентификаторами; в квадратных скобках — тип, проект и тема заметки.',
  'Заметки могут быть из разных проектов. Сведи их в 1–3 карточки-вывода.',
  '',
  'Требования:',
  '- карточка описывает одну тему целиком, а не один ход; заметки одной темы объединяй;',
  '- в `content` — структура: `**What**`, `**Why**`, `**Where**`, `**Learned**` (каждый пункт с новой строки);',
  '- `sources` — массив идентификаторов заметок, на которых карточка основана; только реальные id из списка;',
  '- `scope`: `project` — вывод про один воркспейс (обычный случай); `global` — конвенция, годная в любом проекте; `personal` — про пользователя;',
  '- в `global` и `personal` карточка попадает, только если то же самое видно минимум в двух разных проектах; иначе пиши `project`;',
  '- `topic_key` — короткий слаг темы латиницей, по нему карточка обновляется при повторе;',
  '- ничего не выдумывай: если в заметках нет вывода, не изобретай его;',
  '- не пересказывай заметки по одной: одна заметка без общего вывода карточкой не становится.',
  '',
  'Формат ответа (ровно такой):',
  '[{"title":"…","topic_key":"…","scope":"project","sources":[12,15],"content":"**What**: …\\n**Why**: …\\n**Where**: …\\n**Learned**: …"}]',
  '',
  'Заметки:'
].join('\n')

/** Сообщения для модели: подсказка собирается плагином, не моделью. */
export function buildMessages(notes, { noteChars = 1400 } = {}) {
  const list = notes.map((note) => noteBlock(note, noteChars)).join('\n\n---\n\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${INSTRUCTION}\n\n${list}` }
  ]
}

/** Терпимый разбор ответа модели: снимает обёртку, отбрасывает непроходимые карточки. */
export function parseCards(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.search(/[[{]/)
  if (start < 0) return []
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'))
  if (end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const cards = []
  for (const item of items) {
    const title = String(item?.title ?? '').trim()
    const content = String(item?.content ?? '').trim()
    if (title === '' || content.length < 80) continue
    const sources = (Array.isArray(item?.sources) ? item.sources : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
    const scope = ['project', 'personal', 'global'].includes(item?.scope) ? item.scope : 'project'
    const topicKey = String(item?.topic_key ?? '').trim().toLowerCase().replace(/[^a-z0-9/-]+/g, '-').replace(/^-+|-+$/g, '')
    cards.push({ title, content, sources, scope, topicKey })
  }
  return cards
}

/**
 * Тело карточки: вывод модели плюс строка источников, собранная плагином.
 * Ссылки на сырые заметки сохраняют точность: по ним всегда видно, откуда вывод.
 */
export function cardBody(card, { maxChars = 2000 } = {}) {
  const sources = card.sources.length > 0 ? `Источники: ${card.sources.map((id) => `#${id}`).join(', ')}` : ''
  const text = sources === '' ? card.content : `${card.content}\n\n${sources}`
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Аргументы CLI engram на одну карточку: тема делает запись обновляемой, а не новой. */
export function cardSaveArgs(card, project) {
  const args = ['save', card.title, cardBody(card), '--project', project, '--scope', card.scope, '--type', card.kind]
  if (card.topicKey !== '') args.push('--topic', card.topicKey)
  return args
}

/** Вид карточки: выводы и решения — не «обнаруженное». */
export function cardKind(card, fallback = 'pattern') {
  return CARD_TYPES.includes(fallback) ? fallback : 'pattern'
}

/** Проект, которого в порции больше всего: запасной адрес для карточки без источников. */
function dominantProject(notes) {
  const counts = new Map()
  for (const note of notes) {
    const project = typeof note.project === 'string' ? note.project : ''
    if (project === '') continue
    counts.set(project, (counts.get(project) ?? 0) + 1)
  }
  let best = ''
  let top = 0
  for (const [project, count] of counts) {
    if (count > top) {
      best = project
      top = count
    }
  }
  return best
}

/**
 * Куда ложится карточка и с каким слоем.
 *
 * Правила проверяет плагин, а не модель:
 *   • общий слой (`global`/`personal`) — только если источники карточки лежат в
 *     двух разных проектах; иначе это правило одного проекта, и оно понижается
 *     (иначе общий слой превращается в свалку из случайных выводов);
 *   • проектная карточка пишется в проект своих источников (по большинству),
 *     чужие ссылки из тела убираются: карточка про один проект не должна
 *     помечать заметки другого.
 */
export function planCard(card, notes, { fallback = '' } = {}) {
  const byId = new Map(notes.map((note) => [note.id, typeof note.project === 'string' ? note.project : '']))
  const counts = new Map()
  for (const id of card.sources) {
    const project = byId.get(id)
    if (typeof project !== 'string' || project === '') continue
    counts.set(project, (counts.get(project) ?? 0) + 1)
  }
  let best = null
  for (const [project, count] of counts) {
    if (best === null || count > best.count) best = { project, count }
  }
  const shared = SHARED_SCOPES.includes(card.scope)
  if (shared && counts.size >= 2) {
    return { scope: card.scope, project: best.project, sources: card.sources, downgraded: false }
  }
  const project = best?.project ?? fallback
  return {
    scope: 'project',
    project,
    sources: card.sources.filter((id) => byId.get(id) === project),
    downgraded: shared
  }
}

/**
 * Полный проход: собрать заметки, получить от модели карточки, записать их.
 * Всё внешнее (модель, запись, время) приходит снаружи — проход проверяем без
 * сети и без настоящего engram.
 */
export async function consolidate({
  store,
  project,
  complete,
  save,
  notes: prepared,
  limit = 20,
  maxChars = 12000,
  noteChars = 1400,
  kind = 'pattern',
  timeoutMs = 90000,
  signal,
  log = () => {},
  dryRun = false
}) {
  const notes = prepared ?? collectNotes(store, { project, limit, maxChars })
  if (notes.length === 0) return { status: 'empty', notes: 0, cards: [], saved: [] }
  const messages = buildMessages(notes, { noteChars })
  const started = Date.now()
  let answer
  try {
    answer = await complete(messages, { timeoutMs, signal })
  } catch (error) {
    log(`обобщение: модель не ответила — ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'model-failed', notes: notes.length, cards: [], saved: [], error: String(error?.message ?? error) }
  }
  const parsed = parseCards(answer?.text ?? answer).map((card) => ({ ...card, kind: cardKind(card, kind) }))
  if (parsed.length === 0) {
    log('обобщение: модель не предложила ни одной карточки')
    return { status: 'no-cards', notes: notes.length, cards: [], saved: [], usage: answer?.usage }
  }
  const known = new Set(notes.map((note) => note.id))
  const fallback = dominantProject(notes)
  const cards = []
  const saved = []
  for (const card of parsed) {
    // Источники, которых не было в подборке, отбрасываем: ссылка на непрочитанную
    // заметку — это уже выдумка, а не вывод.
    card.sources = card.sources.filter((id) => known.has(id))
    const plan = planCard(card, notes, { fallback })
    if (plan.project === '') {
      log(`обобщение: у карточки «${card.title}» не нашлось проекта — пропускаю`)
      continue
    }
    const final = { ...card, scope: plan.scope, project: plan.project, sources: plan.sources, downgraded: plan.downgraded }
    cards.push(final)
    if (dryRun) continue
    try {
      await save(cardSaveArgs(final, final.project))
      saved.push({
        title: final.title,
        topicKey: final.topicKey,
        sources: final.sources,
        scope: final.scope,
        project: final.project,
        downgraded: final.downgraded
      })
    } catch (error) {
      log(`обобщение: карточку «${final.title}» записать не удалось — ${error.message}`)
    }
  }
  if (cards.length === 0) return { status: 'no-cards', notes: notes.length, cards: [], saved: [], usage: answer?.usage }
  return {
    status: 'ok',
    notes: notes.length,
    cards,
    saved,
    dryRun,
    durationMs: Date.now() - started,
    usage: answer?.usage,
    model: answer?.model
  }
}

/** Расход токенов по проходам складывается: в отчёте нужна цена всего нажатия. */
function addUsage(total, usage) {
  if (usage === undefined || usage === null) return total
  return {
    promptTokens: (total?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
    completionTokens: (total?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
    totalTokens: (total?.totalTokens ?? 0) + (usage.totalTokens ?? 0)
  }
}

/**
 * Обработка всех проектов порциями: одно нажатие закрывает всё, а размер запроса
 * к модели остаётся предсказуемым — он зависит от порции, а не от числа проектов.
 *
 * Проход — это порция заметок; в ней могут быть заметки разных проектов, поэтому
 * общий слой здесь и появляется законно. После каждой порции карточки
 * записываются, и берётся следующий кусок, пока есть несведённое.
 *
 * Предохранители: предел проходов за нажатие (`maxPasses`) и остановка, если
 * проход не дал ни одной карточки, — заметки без вывода иначе ходили бы по кругу.
 * Отмена работает между проходами: текущий проход дожидается модели.
 */
export async function consolidateAll({
  store,
  complete,
  save,
  projects = null,
  limit = 20,
  maxChars = 12000,
  noteChars = 1400,
  kind = 'pattern',
  timeoutMs = 300000,
  maxPasses = 3,
  dryRun = false,
  signal,
  log = () => {},
  onProgress
} = {}) {
  const names = Array.isArray(projects) ? projects.filter((name) => typeof name === 'string' && name !== '') : null
  const scope = scopeStatistics(store, { projects: names })
  const plannedByProject = scope.projects
    .filter((bucket) => bucket.unprocessed > 0)
    .map((bucket) => ({ project: bucket.project, unprocessed: bucket.unprocessed }))
  const total = plannedByProject.reduce((sum, bucket) => sum + bucket.unprocessed, 0)
  const passLimit = dryRun ? 1 : Math.max(1, maxPasses)
  const result = {
    status: total === 0 ? 'empty' : 'ok',
    passes: 0,
    notes: 0,
    processed: 0,
    cards: [],
    saved: [],
    usage: null,
    model: null,
    planned: total,
    left: total,
    plannedByProject,
    stopped: total === 0 ? 'empty' : null,
    dryRun
  }
  if (total === 0) return result
  const projectNames = plannedByProject.map((bucket) => bucket.project)
  for (let pass = 1; pass <= passLimit; pass += 1) {
    if (signal?.aborted) {
      result.status = 'cancelled'
      result.stopped = 'cancelled'
      return result
    }
    const batch = collectNotes(store, { projects: projectNames, limit, maxChars })
    if (batch.length === 0) {
      result.stopped = 'nothing-to-take'
      break
    }
    const one = await consolidate({ store, notes: batch, complete, save, kind, timeoutMs, noteChars, signal, log, dryRun })
    if (one.status === 'empty') {
      result.stopped = 'nothing-to-take'
      break
    }
    if (one.status === 'model-failed') {
      // Отмена и отказ модели — разные вещи: отмену показываем отменой.
      result.status = signal?.aborted ? 'cancelled' : 'model-failed'
      result.stopped = result.status === 'cancelled' ? 'cancelled' : 'model-failed'
      result.error = one.error
      return result
    }
    result.passes = pass
    result.notes += one.notes ?? batch.length
    result.cards.push(...one.cards)
    result.saved.push(...one.saved)
    result.usage = addUsage(result.usage, one.usage)
    result.model = one.model ?? result.model
    // Остаток берём из базы, а не из арифметики: карточки записал engram, и
    // только он знает, что уже сведено.
    result.left = scopeStatistics(store, { projects: projectNames }).unprocessed
    result.processed = result.planned - result.left
    onProgress?.({
      pass,
      passes: passLimit,
      processed: result.processed,
      total: result.planned,
      left: result.left,
      cards: result.saved.length
    })
    if (one.status === 'no-cards') {
      result.status = 'no-cards'
      result.stopped = 'no-cards'
      return result
    }
    if (result.left === 0) break
  }
  if (result.stopped === null && result.left > 0) result.stopped = 'limit'
  return result
}

/**
 * Цена нажатия до его начала: сколько проходов и сколько знаков уйдёт в модель.
 * Считается по той самой порции, которую возьмёт первый проход, — оценка честная,
 * а не «примерно столько же».
 */
export function estimateRun({
  store,
  projects = null,
  limit = 20,
  maxChars = 12000,
  maxPasses = 3,
  charsPerToken = 3,
  systemChars = 700
} = {}) {
  const names = Array.isArray(projects) ? projects.filter((name) => typeof name === 'string' && name !== '') : null
  const scope = scopeStatistics(store, { projects: names })
  const pending = scope.projects.filter((bucket) => bucket.unprocessed > 0).sort((a, b) => b.unprocessed - a.unprocessed)
  const empty = {
    planned: 0,
    passes: 0,
    maxPasses,
    capped: false,
    perPassNotes: 0,
    perPassTokens: 0,
    tokens: 0,
    charsPerToken,
    projects: []
  }
  if (scope.unprocessed === 0) return empty
  const sample = collectNotes(store, { projects: pending.map((bucket) => bucket.project), limit, maxChars })
  const chars = sample.reduce((sum, note) => sum + String(note.title ?? '').length + String(note.content ?? '').length + 32, 0)
  const perPassNotes = Math.max(1, sample.length)
  const perPassTokens = Math.round(chars / charsPerToken + systemChars)
  const rawPasses = Math.ceil(scope.unprocessed / perPassNotes)
  const passes = Math.max(1, Math.min(rawPasses, Math.max(1, maxPasses)))
  return {
    planned: scope.unprocessed,
    passes,
    maxPasses,
    capped: rawPasses > passes,
    perPassNotes,
    perPassTokens,
    tokens: passes * perPassTokens,
    charsPerToken,
    projects: pending.map((bucket) => ({ project: bucket.project, unprocessed: bucket.unprocessed }))
  }
}

/** Число с разделителями разрядов: «14 200» читается быстрее, чем «14200». */
function formatNumber(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Падеж для слова после числа: 1 проход, 2 прохода, 5 проходов. */
function plural(count, one, few, many) {
  const mod10 = Math.abs(count) % 10
  const mod100 = Math.abs(count) % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Строки про карточки: их показывает и отчёт одного прохода, и отчёт нажатия. */
function cardLines(cards) {
  return cards.map((card) => {
    const absorbed = card.sources.length
    const sources = absorbed > 0 ? ` · ${absorbed} ${plural(absorbed, 'заметка', 'заметки', 'заметок')}` : ''
    const where = card.scope === 'project' ? '' : ` (${card.scope})`
    return `• ${card.title}${where}${sources}`
  })
}

/**
 * Куда легли карточки. Список проектов на вкладке — это очередь, и обнулённый
 * проект из неё уходит; строка отвечает, где карточки на самом деле.
 */
function projectLine(cards) {
  const counts = new Map()
  for (const card of cards) {
    const project = typeof card.project === 'string' && card.project !== '' ? card.project : '—'
    counts.set(project, (counts.get(project) ?? 0) + 1)
  }
  if (counts.size === 0) return []
  const parts = [...counts].map(([project, count]) => `${project} — ${count}`)
  return counts.size === 1 ? [`Карточки легли в проект: ${parts[0]}.`] : [`Карточки легли в проекты: ${parts.join(', ')}.`]
}

/** Текст отчёта одного прохода. */
export function renderReport(result) {
  if (result.status === 'empty') return 'Обобщать нечего: сырых заметок по проекту нет.'
  if (result.status === 'model-failed') return `Обобщение не выполнено: модель не ответила (${result.error}). Заметки не тронуты.`
  if (result.status === 'no-cards') return `Модель не предложила ни одной карточки по ${result.notes} заметкам. Заметки не тронуты.`
  const count = result.dryRun ? result.cards.length : result.saved.length
  const units = `${count} ${plural(count, 'карточка-вывод', 'карточки-выводы', 'карточек-выводов')}`
  const head = result.dryRun
    ? `Черновик по ${result.notes} заметкам: ${count} ${plural(count, 'карточка', 'карточки', 'карточек')} — ничего не записано.`
    : `Сведено ${result.notes} ${plural(result.notes, 'заметка', 'заметки', 'заметок')} → ${units}.`
  const lines = cardLines(result.cards)
  const downgraded = result.cards.filter((card) => card.downgraded === true).length
  if (downgraded > 0) lines.push(`• ${downgraded} карточк(и) остались проектными: для общего слоя нужны источники из разных проектов.`)
  const spent = result.usage ? ` Токенов: ${formatNumber(result.usage.totalTokens)}.` : ''
  return [`${head}${spent}`, ...projectLine(result.cards), ...lines].join('\n')
}

/**
 * Текст отчёта после нажатия: сколько сведено, куда, во сколько обошлось и почему
 * обработка остановилась, если остановилась. Интерфейс показывает его как есть.
 */
export function renderRunReport(result) {
  if (result.status === 'empty') return 'Обрабатывать нечего: несведённых заметок нет.'
  if (result.status === 'model-failed') {
    return `Обобщение не выполнено: модель не ответила (${result.error}). Заметки не тронуты.`
  }
  if (result.status === 'cancelled') {
    return `Обработка отменена: сведено ${result.processed} из ${result.planned}, карточек записано ${result.saved.length}. Заметки не тронуты.`
  }
  if (result.status === 'no-cards') {
    return (
      `Модель не предложила ни одной карточки по ${result.notes} заметкам — остановился, ` +
      'чтобы не ходить по кругу. Заметки не тронуты.'
    )
  }
  if (result.plannedByProject.length <= 1 && result.passes <= 1) return renderReport(result)

  const head = result.dryRun
    ? `Черновик по ${result.notes} заметкам: ${result.cards.length} ${plural(result.cards.length, 'карточка', 'карточки', 'карточек')} — ничего не записано.`
    : `Сведено ${result.processed} ${plural(result.processed, 'заметка', 'заметки', 'заметок')} → ` +
      `${result.saved.length} ${plural(result.saved.length, 'карточка-вывод', 'карточки-выводы', 'карточек-выводов')} за ` +
      `${result.passes} ${plural(result.passes, 'проход', 'прохода', 'проходов')}.`
  const spent = result.usage ? ` Токенов: ${formatNumber(result.usage.totalTokens)}.` : ''
  const lines = [head + spent, ...projectLine(result.cards)]
  lines.push(...cardLines(result.cards))
  const downgraded = result.cards.filter((card) => card.downgraded === true).length
  if (downgraded > 0) lines.push(`• ${downgraded} карточк(и) остались проектными: для общего слоя нужны источники из разных проектов.`)
  if (result.stopped === 'limit') {
    lines.push(`Остановился на пределе ${result.passes} проходов: несведённых заметок ещё ${result.left} — нажмите ещё раз.`)
  }
  if (result.stopped === 'nothing-to-take') lines.push('Порция оказалась пустой — обработку остановил.')
  return lines.join('\n')
}
