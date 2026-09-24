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
/** Ключи аргументов, в которых лежит путь к файлу. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'filename']

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

/** Строки-заголовки, которые ничего не сообщают: приветствие не должно становиться именем записи. */
const GREETING_LINE = /^(привет|здравствуй(те)?|добрый (день|вечер)|хай|hi|hello|hey|ок|ok|готово|done|спасибо)[!.,…\s]*$/i
/** Строка короче этого не тянет на заголовок, если дальше есть содержательная. */
const MIN_TITLE_LINE = 24

/** Одна строка текста без markdown-акцентов и служебных префиксов. */
function cleanLine(raw) {
  return String(raw ?? '')
    .replace(/^[#*\s>•\-–—]+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Первая содержательная строка текста, укороченная до заголовка записи. */
export function titleFrom(text, max = 120) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line !== '')
  const meaningful = lines.find((line) => line.length >= MIN_TITLE_LINE && !GREETING_LINE.test(line))
  const chosen = meaningful ?? lines[0] ?? ''
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
    requireChange = true,
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
      if (WRITE_TOOL.test(block.name ?? '')) {
        const file = pathOf(argumentsObject)
        if (file !== null && !files.includes(file)) files.push(file)
        continue
      }
      if (COMMAND_TOOL.test(block.name ?? '')) {
        const command = typeof argumentsObject.command === 'string' ? argumentsObject.command : ''
        if (command !== '' && !commands.includes(command)) commands.push(command)
      }
    }
  }

  if (!sawAssistant) return null
  const trimmedSummary = summary.trim()
  if (trimmedSummary.length < minSummary) return null
  if (requireChange && files.length === 0 && commands.length === 0) return null

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
