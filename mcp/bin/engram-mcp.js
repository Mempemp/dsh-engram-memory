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
  if (explicit !== '') {
    env.ENGRAM_PROJECT = explicit
  } else {
    const fromState = projectFromState([
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH-1C', 'engram-current-project.json') : undefined
    ])
    if (fromState !== null) {
      env.ENGRAM_PROJECT = fromState
      process.stderr.write(`engram-mcp: проект — ${fromState} (последняя рабочая область)\n`)
    } else {
      process.stderr.write('engram-mcp: проект не назван — engram возьмёт имя своего рабочего каталога\n')
    }
  }

  // Профиль инструментов задаётся аргументом, а не ENGRAM_TOOLS: переменная в
  // бинарнике есть, но на список инструментов не влияет (проверено на v2.0.0).
  // agent — 19 инструментов вместо 23, меньше схем в промпте.
  const args = ['mcp', `--tools=${config.tools || 'agent'}`]
  const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.on('error', (error) => {
    process.stderr.write(`engram-mcp: не запустился ${exe}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
}

// Запуск только при прямом вызове: тесты берут отсюда чистые функции.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
