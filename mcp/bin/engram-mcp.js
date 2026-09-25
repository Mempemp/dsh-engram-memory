#!/usr/bin/env node
// Запускает engram.exe как stdio-MCP сервер для DSH.
//
// Зачем прокладка: каталожный сид бандла умеет задавать серверу только
// command/args (McpManagerServerEntry), а окружение санитизируется до
// вайтлиста — ENGRAM_NO_UPDATE_CHECK, ENGRAM_TOOLS и каталог данных так не
// передать. Прокладка ставит их сама и прозрачно прокидывает stdio в дочерний
// процесс.
//
// Проект для записей: без имени engram берёт свой рабочий каталог, а у сервера
// это каталог запуска десктопа — так в базе появлялись `launch-root`, `package`
// и `probe_ws`. Имя берём из снимка, который пишет плагин (там, где человек
// работал последний раз); явная настройка `project` в конфиге важнее.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Конфиг: берём первый существующий путь из списка. */
export function readConfig(candidates) {
  for (const path of candidates) {
    if (typeof path !== 'string' || path === '' || !existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      process.stderr.write(`engram-mcp: конфиг ${path} не прочитан: ${error.message}\n`)
    }
  }
  return {}
}

/** Проект из снимка хоста: нет файла, битый файл, пустое имя — проекта нет. */
export function projectFromState(paths) {
  for (const path of paths) {
    if (typeof path !== 'string' || path === '' || !existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const project = parsed?.project
      if (typeof project === 'string' && project.trim() !== '') return project.trim()
    } catch {
      // Битый снимок не повод падать: ниже сервер пойдёт своим путём.
    }
  }
  return null
}

// Записи, где проект — часть самой записи. Чтение не трогаем: модель должна
// искать по всей памяти, а не только по последней рабочей области.
const WRITE_TOOLS = new Set(['mem_save', 'mem_save_prompt'])

/**
 * Подставляет проект в запись памяти, если модель его не назвала.
 *
 * Переменная окружения тут не помогает: она задана один раз при запуске, а
 * человек за сессию успевает поработать в другой области. Поэтому проект
 * подставляется в каждый вызов — тогда записи не уезжают в каталог запуска
 * приложения.
 */
export function injectProject(line, project) {
  if (typeof line !== 'string' || line === '' || typeof project !== 'string' || project === '') return line
  let message = null
  try {
    message = JSON.parse(line)
  } catch {
    return line
  }
  if (message?.method !== 'tools/call') return line
  const name = message.params?.name
  if (typeof name !== 'string' || !WRITE_TOOLS.has(name)) return line
  const args = message.params?.arguments
  if (args !== null && typeof args === 'object' && typeof args.project === 'string' && args.project.trim() !== '') return line
  return JSON.stringify({ ...message, params: { ...message.params, arguments: { ...(args ?? {}), project } } })
}

function main() {
  const exe = process.env.ENGRAM_BIN || join(here, '..', 'engram.exe')
  if (!existsSync(exe)) {
    process.stderr.write(`engram-mcp: нет бинарника ${exe}\n`)
    process.exit(1)
  }

  // Тот же файл читает плагин, который инжектит память в pre-step, поэтому путь
  // к данным задаётся в одном месте.
  const config = readConfig([
    process.env.ENGRAM_MCP_CONFIG,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH-1C', 'engram-mcp.json') : undefined,
    join(here, '..', 'engram-mcp.json')
  ])

  const env = {
    ...process.env,
    // Апстрим проверяет обновления на api.github.com при каждом запуске; в
    // офлайновой поставке это лишний сетевой вызов и мусор в логе.
    ENGRAM_NO_UPDATE_CHECK: '1'
  }
  if (config.dataDir) env.ENGRAM_DATA_DIR = config.dataDir
  if (config.timezone) env.ENGRAM_TIMEZONE = config.timezone

  const explicit = typeof config.project === 'string' ? config.project.trim() : ''
  // Снимок читается на каждый вызов: человек за сессию переключается между
  // рабочими областями, и записи должны уходить в ту, где он сейчас.
  const statePaths = () => [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH-1C', 'engram-current-project.json') : undefined
  ]
  const projectNow = () => (explicit !== '' ? explicit : projectFromState(statePaths()))

  const first = projectNow()
  if (first !== null) {
    env.ENGRAM_PROJECT = first
    process.stderr.write(`engram-mcp: проект — ${first} (последняя рабочая область)\n`)
  } else {
    process.stderr.write('engram-mcp: проект не назван — engram возьмёт имя своего рабочего каталога\n')
  }

  // Профиль инструментов задаётся аргументом, а не ENGRAM_TOOLS: переменная в
  // бинарнике есть, но на список инструментов не влияет (проверено на v2.0.0).
  // agent — 19 инструментов вместо 23, меньше схем в промпте.
  const args = ['mcp', `--tools=${config.tools || 'agent'}`]
  const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  child.on('error', (error) => {
    process.stderr.write(`engram-mcp: не запустился ${exe}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())

  // Запросы идут строками JSON. Свои строки пропускаем как есть, в записи
  // памяти добавляем проект — так просит только тот вызов, где он нужен.
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) child.stdin.write(injectProject(line, projectNow()) + '\n')
  })
  process.stdin.on('end', () => {
    if (pending !== '') child.stdin.write(injectProject(pending, projectNow()))
    child.stdin.end()
  })
  child.stdout.pipe(process.stdout)
}

// Запуск только при прямом вызове: тесты берут отсюда чистые функции.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
