#!/usr/bin/env node
// Запускает engram.exe как stdio-MCP сервер для DSH.
//
// Зачем шим: каталожный сид бандла умеет задавать серверу только command/args
// (McpManagerServerEntry), а окружение санитизируется до вайтлиста —
// ENGRAM_NO_UPDATE_CHECK, ENGRAM_TOOLS и каталог данных так не передать.
// Шим ставит их сам и прозрачно прокидывает stdio в дочерний процесс.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const exe = process.env.ENGRAM_BIN || join(here, '..', 'engram.exe')
if (!existsSync(exe)) {
  process.stderr.write(`engram-mcp: нет бинарника ${exe}\n`)
  process.exit(1)
}

// Необязательный конфиг. Тот же файл читает плагин, который инжектит память
// в pre-step, поэтому путь к данным задаётся в одном месте.
const candidates = [
  process.env.ENGRAM_MCP_CONFIG,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH-1C', 'engram-mcp.json') : undefined,
  join(here, '..', 'engram-mcp.json')
].filter(Boolean)
let config = {}
for (const path of candidates) {
  if (!existsSync(path)) continue
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    process.stderr.write(`engram-mcp: конфиг ${path} не прочитан: ${error.message}\n`)
  }
  break
}

const env = {
  ...process.env,
  // Апстрим проверяет обновления на api.github.com при каждом запуске; в
  // офлайновой поставке это лишний сетевой вызов и мусор в логе.
  ENGRAM_NO_UPDATE_CHECK: '1'
}
if (config.dataDir) env.ENGRAM_DATA_DIR = config.dataDir
if (config.project) env.ENGRAM_PROJECT = config.project
if (config.timezone) env.ENGRAM_TIMEZONE = config.timezone

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
