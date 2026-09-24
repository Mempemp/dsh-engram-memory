/**
 * Обобщение (консолидация) памяти: сырые заметки ходов сводятся в карточки-выводы.
 *
 * Разделение обязанностей здесь важнее кода: заметки собирает и пишет плагин
 * (детерминированно, без модели), а сам вывод формулирует модель — она одна
 * знает, что в работе было существенным. Ссылки на источники проставляет плагин
 * по идентификаторам, которые вернула модель: «Источники: #12, #15» — это не
 * украшение, а страховка от потери точности при сжатии.
 */

/** Типы записей, которые считаются сырыми заметками ходов, а не выводами. */
const RAW_TYPES = ['discovery']

/** Типы, которые карточка вывода может получить. */
const CARD_TYPES = ['pattern', 'decision', 'architecture']

export function isRawNote(row, types = RAW_TYPES) {
  const type = String(row?.type ?? '').toLowerCase()
  return types.includes(type) && row?.pinned !== 1 && row?.deleted_at == null
}

/**
 * Сырые заметки проекта для обобщения: свежие сверху, без выводов, без
 * помеченных и без мягко удалённых. Упирается в два предела сразу — число
 * заметок и общий размер текста: длинная подборка съедает контекст модели.
 */
export function collectNotes(store, { project, limit = 20, maxChars = 12000, types = RAW_TYPES } = {}) {
  if (store === null || typeof project !== 'string' || project === '') return []
  let rows = []
  try {
    rows = store
      .prepare(
        `SELECT o.id, o.title, o.content, o.topic_key, o.type, o.scope, o.pinned, o.deleted_at, o.updated_at
           FROM observations o
          WHERE o.project = ? COLLATE NOCASE AND o.deleted_at IS NULL
          ORDER BY o.updated_at DESC, o.id DESC
          LIMIT ?`
      )
      .all(project, Math.max(1, limit * 4))
  } catch {
    return []
  }
  const notes = []
  let used = 0
  for (const row of rows) {
    if (notes.length >= limit) break
    if (!isRawNote(row, types)) continue
    const content = String(row.content ?? '')
    if (used + content.length > maxChars && notes.length > 0) break
    used += content.length
    notes.push(row)
  }
  return notes
}

/** Текст одной заметки для подсказки модели: с идентификатором, по которому её потом сошлются. */
function noteBlock(note) {
  const topic = note.topic_key ? ` тема=${note.topic_key}` : ''
  return `#${note.id} [${note.type}${topic}] ${note.title}\n${String(note.content ?? '').trim()}`
}

const SYSTEM = [
  'Ты сводишь сырые заметки о проделанной работе в карточки-выводы для долговременной памяти.',
  'Твоя задача — не пересказать заметки, а сформулировать знание: что теперь известно и как это делать в следующий раз.',
  'Отвечай только JSON-массивом, без пояснений и без markdown-обёртки.'
].join(' ')

const INSTRUCTION = [
  'Ниже сырые заметки ходов с идентификаторами. Сведи их в 1–3 карточки-вывода.',
  '',
  'Требования:',
  '- карточка описывает одну тему целиком, а не один ход; заметки одной темы объединяй;',
  '- в `content` — структура: `**What**`, `**Why**`, `**Where**`, `**Learned**` (каждый пункт с новой строки);',
  '- `sources` — массив идентификаторов заметок, на которых карточка основана; только реальные id из списка;',
  '- `scope`: `project` — про этот воркспейс, `global` — конвенция, годная в любом проекте, `personal` — про пользователя;',
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
export function buildMessages(notes) {
  const list = notes.map(noteBlock).join('\n\n---\n\n')
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
  kind = 'pattern',
  timeoutMs = 90000,
  signal,
  log = () => {},
  dryRun = false
}) {
  const notes = prepared ?? collectNotes(store, { project, limit, maxChars })
  if (notes.length === 0) return { status: 'empty', notes: 0, cards: [], saved: [] }
  const messages = buildMessages(notes)
  const started = Date.now()
  let answer
  try {
    answer = await complete(messages, { timeoutMs, signal })
  } catch (error) {
    log(`обобщение: модель не ответила — ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'model-failed', notes: notes.length, cards: [], saved: [], error: String(error?.message ?? error) }
  }
  const cards = parseCards(answer?.text ?? answer).map((card) => ({ ...card, kind: cardKind(card, kind) }))
  if (cards.length === 0) {
    log('обобщение: модель не предложила ни одной карточки')
    return { status: 'no-cards', notes: notes.length, cards: [], saved: [], usage: answer?.usage }
  }
  const known = new Set(notes.map((note) => note.id))
  const saved = []
  for (const card of cards) {
    // Источники, которых не было в подборке, отбрасываем: ссылка на непрочитанную
    // заметку — это уже выдумка, а не вывод.
    card.sources = card.sources.filter((id) => known.has(id))
    if (dryRun) continue
    const args = cardSaveArgs(card, project)
    try {
      await save(args)
      saved.push({ title: card.title, topicKey: card.topicKey, sources: card.sources })
    } catch (error) {
      log(`обобщение: карточку «${card.title}» записать не удалось — ${error.message}`)
    }
  }
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

/** Текст отчёта: его показывает интерфейс после команды. */
export function renderReport(result) {
  if (result.status === 'empty') return 'Обобщать нечего: сырых заметок по проекту нет.'
  if (result.status === 'model-failed') return `Обобщение не выполнено: модель не ответила (${result.error}). Заметки не тронуты.`
  if (result.status === 'no-cards') return `Модель не предложила ни одной карточки по ${result.notes} заметкам. Заметки не тронуты.`
  const head = result.dryRun
    ? `Черновик по ${result.notes} заметкам: ${result.cards.length} карточк(и) — ничего не записано.`
    : `Обобщено ${result.notes} заметок → ${result.saved.length} карточк(и) в памяти.`
  const lines = result.cards.map((card) => {
    const sources = card.sources.length > 0 ? ` ← ${card.sources.map((id) => `#${id}`).join(', ')}` : ''
    const where = card.scope === 'project' ? '' : ` (${card.scope})`
    return `• ${card.title}${where}${sources}`
  })
  const spent = result.usage ? ` Токенов: ${result.usage.totalTokens ?? '—'}.` : ''
  return [`${head}${spent}`, ...lines, 'Сырые заметки остались на месте.'].join('\n')
}
