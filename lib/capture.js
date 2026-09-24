// Память engram: разбор законченного хода в запись — без модели и без LLM.
//
// Плагин читает уже готовую историю хода (запрос пользователя, вызовы
// инструментов, итоговый текст) и строит из неё компактную запись. Триггер
// консервативный: запись появляется только если в ходе менялись файлы или
// выполнялись команды и есть содержательный итог. Тема (`--topic`) — признак
// пакета работ, чтобы engram обновлял запись, а не плодил дубли.

/** Инструменты, которые считаются изменением проекта. */
const WRITE_TOOL = /^(write|edit|patch|apply_patch|multi_edit|create_file|delete_file|move_file)$/i
/** Инструменты, которые считаются выполненной работой. */
const COMMAND_TOOL = /^(bash|sh|shell|pwsh|powershell|cmd|exec|run_command|terminal)$/i
/** Инструменты, которыми ход изучает проект: не меняют, но приносят знание. */
const READ_TOOL = /^(read|glob|grep|search|web_search|web_fetch|fetch|list_dir|ls|find)$/i
/** Ключи аргументов, в которых лежит путь к файлу (или запрос для поиска). */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'filename', 'pattern', 'url', 'query']

function parseArguments(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function pathOf(argumentsObject) {
  for (const key of PATH_KEYS) {
    const value = argumentsObject[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/** Строки, которые ничего не сообщают: междометие не должно становиться именем записи. */
const GREETING_LINE = /^(привет|здравствуй(те)?|добрый (день|вечер)|хай|hi|hello|hey|ок|ok|готово|done|спасибо|сделал|есть|да|нет|всё|все)[!.,…\s]*$/i
/** Строка такой длины тянет на заголовок без оговорок. */
const MIN_TITLE_LINE = 24

/** Одна строка текста без markdown-акцентов и служебных префиксов. */
function cleanLine(raw) {
  return String(raw ?? '')
    .replace(/^[#*\s>•\-–—]+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Годится ли строка в заголовок. Междометие («Привет!», «Готово») — нет.
 * Короткая строка годится, если несёт конкретику: число, двоеточие или три
 * слова — «Фикс 413», «Диаризация: выбор движка» это заголовки, «Ок» нет.
 */
function isTitleCandidate(line) {
  if (line === '' || GREETING_LINE.test(line)) return false
  if (line.length >= MIN_TITLE_LINE) return true
  return /\d/.test(line) || /:/.test(line) || line.split(/\s+/).length >= 3
}

/** Первая содержательная строка текста, укороченная до заголовка записи. */
export function titleFrom(text, max = 120) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line !== '')
  const candidate = lines.find(isTitleCandidate) ?? lines[0] ?? ''
  // Приветствие в начале содержательной строки — лишнее, но если кроме него в
  // строке ничего нет, оставляем как есть: пустой заголовок хуже.
  const stripped = candidate
    .replace(/^(привет|здравствуй(те)?|добрый (день|вечер)|хай|hi|hello|hey)(?![а-яёa-z])[!,.\s]*/i, '')
    .trim()
  const chosen = stripped === '' ? candidate : stripped
  // Заголовок укорачивается по той же логике границ: целое предложение, если оно
  // влезает, иначе — до конца слова. Предел `max` остаётся верхней границей.
  return cutText(chosen, max)
}

/** Тема записи: проект + слаг заголовка — engram обновит запись по этой теме. */
export function topicFrom(project, title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '')
  return `${project}/${slug === '' ? 'work' : slug}`
}

/**
 * Границы, по которым можно резать текст, от крупной к мелкой: абзац, строка,
 * конец предложения, конец слова. Оборванное посреди слова многоточие читается
 * как сбой, а не как обрезка.
 */
const BOUNDARIES = ['\n\n', '\n', /(?<=[.!?…])[ \t]+/u, /\s+/u]

/** Последняя граница в тексте: конец найденного разделителя, иначе -1. */
function lastBoundary(text, split) {
  if (typeof split === 'string') return text.lastIndexOf(split)
  const found = [...text.matchAll(new RegExp(split.source, `${split.flags}g`))]
  const last = found.at(-1)
  return last === undefined ? -1 : last.index + last[0].length
}

/**
 * Укоротить текст до предела — по ближайшей границе ниже предела, а не по
 * символу. Предел это верхняя граница, а не цель: запись короче предела, зато
 * последняя фраза в ней целая.
 *
 * `minShare` — какую долю предела граница обязана оставить. Абзац, съедающий
 * половину бюджета, не стоит того, чтобы за него держаться: тогда спускаемся к
 * строке, предложению, слову и лишь в крайнем случае режем по символу.
 */
function cutText(text, limit, minShare = 0.5) {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  if (limit <= 1) return '…'
  const head = text.slice(0, limit)
  for (const split of BOUNDARIES) {
    const cut = lastBoundary(head, split)
    if (cut >= Math.ceil(limit * minShare)) {
      const kept = head.slice(0, cut).trimEnd().replace(/[.,;:!?—–-]+$/u, '')
      if (kept !== '') return `${kept}…`
    }
  }
  return `${head.slice(0, limit - 1)}…`
}

/**
 * Первая граница в тексте: место, с которого начинается целое слово или фраза.
 * Нужна для обрезки с начала — у вывода важен конец, а не начало.
 */
function firstBoundary(text, split) {
  if (typeof split === 'string') {
    const at = text.indexOf(split)
    return at < 0 ? -1 : at + split.length
  }
  const found = text.match(new RegExp(split.source, split.flags))
  return found === null || found.index === undefined ? -1 : found.index + found[0].length
}

/** Укоротить текст с начала, сохранив конец: вывод живёт в конце текста. */
function cutTail(text, limit, minShare = 0.5) {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  if (limit <= 1) return '…'
  const tail = text.slice(text.length - limit)
  const allowed = Math.ceil(limit * (1 - minShare))
  for (const split of BOUNDARIES) {
    const cut = firstBoundary(tail, split)
    if (cut > 0 && cut <= allowed) {
      const kept = tail.slice(cut).trimStart().replace(/^[.,;:!?—–-]+/u, '')
      if (kept !== '') return `…${kept}`
    }
  }
  return `…${tail.slice(1).trimStart()}`
}

/** Абзацы текста: пустая строка — граница. Таблица или список остаются целым куском. */
const paragraphsOf = (text) => String(text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter((part) => part !== '')

/** Запас на пометку о пропущенной середине — «…пропущено N знаков…». */
const MARKER_ROOM = 40
/** Какая доля бюджета прозы достаётся началу: остальное — выводу. */
const HEAD_SHARE = 0.3

/**
 * Выжимка из прозы: начало (о чём речь) и конец (вывод), середина заменяется
 * пометкой о пропущенном.
 *
 * Модели читают начало и конец, а середину длинного текста не читают вовсе
 * (Liu et al., 2023), поэтому хранить её целиком незачем: важное — по краям.
 * Начало при этом уступает выводу: если бюджета не хватает, короче становится
 * оно, а конец остаётся целым.
 */
function selectProse(text, budget) {
  const trimmed = String(text ?? '').trim()
  if (budget <= 0) return ''
  if (trimmed.length <= budget) return trimmed
  const parts = paragraphsOf(trimmed)
  if (parts.length <= 1) return cutText(trimmed, budget)
  const headBudget = Math.min(parts[0].length, Math.max(120, Math.ceil(budget * HEAD_SHARE)))
  const headText = parts[0].length <= headBudget ? parts[0] : cutText(parts[0], headBudget)
  const tailParts = []
  let tailChars = 0
  const room = () => budget - headText.length - MARKER_ROOM - tailChars - (tailParts.length > 0 ? 2 * tailParts.length : 0)
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const part = parts[index]
    if (part.length <= room()) {
      tailParts.unshift(part)
      tailChars += part.length
      continue
    }
    if (tailParts.length === 0 && room() >= 200) {
      const piece = cutTail(part, room())
      tailParts.unshift(piece)
      tailChars += piece.length
    }
    break
  }
  const tailText = tailParts.join('\n\n')
  let skipped = trimmed.length - headText.length - tailText.length
  if (skipped <= MARKER_ROOM) skipped = 0
  const marker = skipped === 0 ? '' : `…пропущено ${skipped} знаков…`
  const assembled = [headText, marker, tailText].filter((part) => part !== '').join('\n\n')
  if (assembled.length <= budget) return assembled
  const overflow = assembled.length - budget
  const shorter = cutText(headText, Math.max(80, headText.length - overflow))
  const fixed = [shorter, marker, tailText].filter((part) => part !== '').join('\n\n')
  return fixed.length <= budget ? fixed : `${fixed.slice(0, budget - 1)}…`
}

/**
 * Разбирает законченный ход. Возвращает `null`, если запись не нужна.
 *
 * `messages` — история хода вместе с последней репликой пользователя: всё до
 * неё и есть законченный ход. При `turn: 'current'` массив и есть ход целиком
 * (так его отдаёт `turn/end`, где новой реплики ещё нет).
 */
export function digestTurn(messages, options = {}) {
  const {
    minSummary = 200,
    maxChars = 2000,
    listMaxChars = 600,
    titleMax = 200,
    requireChange = false,
    research = true,
    readMin = 3,
    project = 'unknown',
    type = 'discovery',
    turn = 'previous'
  } = options

  const list = Array.isArray(messages) ? messages : []
  const whole = turn === 'current'
  const lastUserIndex = whole ? list.length : list.findLastIndex((message) => message?.source?.kind === 'user')
  if (lastUserIndex <= 0) return null

  let summary = ''
  const files = []
  const commands = []
  const studied = []
  let sawAssistant = false

  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.source?.kind === 'user') break
    if (message?.role !== 'assistant') continue
    sawAssistant = true
    const text = textOf(message)
    if (summary === '' && text !== '') summary = text
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== 'tool-call') continue
      const argumentsObject = parseArguments(block.arguments)
      const name = block.name ?? ''
      if (WRITE_TOOL.test(name)) {
        const file = pathOf(argumentsObject)
        if (file !== null && !files.includes(file)) files.push(file)
        continue
      }
      if (COMMAND_TOOL.test(name)) {
        const command = typeof argumentsObject.command === 'string' ? argumentsObject.command : ''
        if (command !== '' && !commands.includes(command)) commands.push(command)
        continue
      }
      if (READ_TOOL.test(name)) {
        const subject = pathOf(argumentsObject)
        if (subject !== null && !studied.includes(subject)) studied.push(subject)
      }
    }
  }

  if (!sawAssistant) return null
  const trimmedSummary = summary.trim()
  if (trimmedSummary.length < minSummary) return null

  // Ход запоминается, если он что-то сделал (файлы, команды) или что-то выяснил
  // (чтение и поиск): разбор проекта потом экономит работу не меньше правки.
  const didWork = files.length > 0 || commands.length > 0
  const didResearch = research && studied.length >= readMin
  if (!didWork && !didResearch) return null
  if (requireChange && !didWork) return null

  const request = (() => {
    for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
      if (list[index]?.source?.kind === 'user') return textOf(list[index])
    }
    return ''
  })()

  const title = titleFrom(trimmedSummary, titleMax)
  if (title === '') return null

  const requestPart = request === '' ? '' : `Запрос: ${titleFrom(request, 400)}`

  // Списки — единственная машинная часть записи: пути и команды модель заново
  // не выдумает, а прозу всегда можно перечитать в истории. Поэтому бюджет
  // спискам считается первым, и проза режется раньше них.
  const listParts = []
  let listLeft = Math.max(0, listMaxChars)
  const takeLine = (prefix, items, separator = ', ') => {
    if (items.length === 0 || listLeft <= prefix.length + 8) return
    const kept = []
    let used = prefix.length
    for (const item of items) {
      const piece = kept.length === 0 ? item : `${separator}${item}`
      if (used + piece.length > listLeft) break
      kept.push(item)
      used += piece.length
    }
    if (kept.length === 0) {
      // Один длинный путь всё равно полезнее, чем ничего: режем его самого.
      listParts.push(`${prefix}${cutText(items[0], listLeft - prefix.length)}`)
      listLeft = 0
      return
    }
    listParts.push(`${prefix}${kept.join(separator)}`)
    listLeft -= used + 2
  }
  takeLine('Файлы: ', files.slice(0, 12))
  if (files.length === 0) takeLine('Прочитано: ', studied.slice(0, 10))
  takeLine('Команды: ', commands.slice(0, 5).map((command) => titleFrom(command, 120)), ' | ')

  const parts = []
  if (requestPart !== '') parts.push(requestPart)
  const separators = 2 * ((requestPart === '' ? 0 : 1) + listParts.length)
  const fixedChars = requestPart.length + listParts.reduce((sum, part) => sum + part.length, 0) + separators
  const proseBudget = maxChars - fixedChars - 'Итог: '.length
  parts.push(`Итог: ${selectProse(trimmedSummary, proseBudget)}`)
  parts.push(...listParts)

  let content = parts.join('\n\n')
  if (content.length > maxChars) content = `${content.slice(0, maxChars - 1)}…`

  return { title, content, project, type, topic: topicFrom(project, title) }
}

/** Аргументы CLI-записи: пишет сам engram, плагин только просит. */
export function saveArgs(record) {
  return [
    'save',
    record.title,
    record.content,
    '--project',
    record.project,
    '--scope',
    'project',
    '--type',
    record.type ?? 'discovery',
    '--topic',
    record.topic
  ]
}

/**
 * Заметка так, как её получает тот, кто читает много заметок сразу — проход
 * обобщения: запрос и ключи (пути, команды) целиком, проза — началом и концом.
 *
 * Нужна, чтобы цена обобщения не зависела от длины ответа: заметка от длинного
 * хода читается моделью как заметка от короткого, теряется только пересказ
 * середины — то, что модель и так не читает.
 */
export function narrowNote(content, budget = 1400) {
  const text = String(content ?? '').trim()
  if (text === '' || text.length <= budget) return text
  const parts = paragraphsOf(text)
  const fixed = parts.filter((part) => /^(Запрос|Файлы|Команды|Прочитано): /u.test(part))
  const prose = parts.filter((part) => !fixed.includes(part)).join('\n\n')
  const fixedChars = fixed.reduce((sum, part) => sum + part.length + 2, 0)
  const narrowed = selectProse(prose, Math.max(200, budget - fixedChars))
  const out = []
  let prosePlaced = false
  for (const part of parts) {
    if (fixed.includes(part)) {
      out.push(part)
      continue
    }
    if (!prosePlaced) {
      out.push(narrowed)
      prosePlaced = true
    }
  }
  return out.filter((part) => part !== '').join('\n\n')
}
