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
  return chosen.length > max ? `${chosen.slice(0, max - 1)}…` : chosen
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

  const title = titleFrom(trimmedSummary)
  if (title === '') return null

  const parts = []
  if (request !== '') parts.push(`Запрос: ${titleFrom(request, 400)}`)
  parts.push(`Итог: ${trimmedSummary}`)
  if (files.length > 0) parts.push(`Файлы: ${files.slice(0, 12).join(', ')}`)
  if (files.length === 0 && studied.length > 0) parts.push(`Прочитано: ${studied.slice(0, 10).join(', ')}`)
  if (commands.length > 0) parts.push(`Команды: ${commands.slice(0, 5).map((c) => titleFrom(c, 120)).join(' | ')}`)

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
