/**
 * Самодостаточность пакета: MCP-половина (бинарь engram + шим) лежит внутри
 * плагина, поэтому плагин сам раскладывает её туда, откуда её берёт десктоп, и
 * сам объявляет сервер в `dsh-mcp.json`.
 *
 * Идемпотентно: если файлы уже этой версии и запись сервера есть — не делается
 * ничего. Существующая запись сервера не переписывается никогда: она может быть
 * настроена человеком (свой каталог данных, профиль инструментов).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const MCP_NAME = 'engram'
const SHIM = join('bin', 'engram-mcp.js')

/** Каталог харнесса десктопа: настройка → DSH_HOME → %APPDATA%\dsh-desktop\harness. */
export function harnessDir(config = {}, env = process.env) {
  const configured = typeof config.harnessDir === 'string' ? config.harnessDir.trim() : ''
  if (configured !== '') return configured
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (home !== '') return home
  const appData = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : ''
  if (appData !== '') return join(appData, 'dsh-desktop', 'harness')
  return null
}

/** Каталог MCP-половины внутри пакета плагина. */
export function bundledMcpDir(pluginDir) {
  return join(pluginDir, 'mcp')
}

/** Версия MCP-половины: файл-маркер рядом с бинарником. */
export function mcpVersion(dir) {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Узел для запуска шима. Десктоп запускает MCP-сервер сам, поэтому берём узел из
 * его же установки: свой процесс может быть Electron-бинарником, из которого
 * сервер не поднимется.
 */
export function resolveNode(config = {}, { env = process.env, execPath = process.execPath } = {}) {
  const configured = typeof config.nodePath === 'string' ? config.nodePath.trim() : ''
  if (configured !== '') return configured
  const name = basename(execPath || '').toLowerCase()
  if (name.startsWith('node')) return execPath
  const desktop = execPath ? join(dirname(execPath), 'resources', 'app', 'node_modules', 'node', 'bin', 'node.exe') : ''
  if (desktop !== '' && existsSync(desktop)) return desktop
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME : ''
  if (home !== '') {
    const shared = join(home, 'node.exe')
    if (existsSync(shared)) return shared
  }
  return 'node'
}

/**
 * Раскладывает бинарник и шим в `<harness>/mcp/engram/package`. Версия помечена
 * файлом VERSION: совпала — копирования нет.
 *
 * Запертый бинарник (сервер уже запущен и держит файл) — не ошибка: копия
 * заменится при следующем запуске, а работающая половина остаётся рабочей.
 */
export function ensureMcpPackage(harness, bundled, { log = () => {} } = {}) {
  const target = join(harness, 'mcp', MCP_NAME, 'package')
  const wanted = mcpVersion(bundled)
  for (const file of [join(target, 'engram.exe'), join(target, SHIM)]) {
    if (!existsSync(join(bundled, file.slice(target.length + 1)))) return { action: 'absent' }
  }
  if (existsSync(join(target, 'engram.exe')) && mcpVersion(target) === wanted && wanted !== '') {
    return { action: 'current', target }
  }
  try {
    mkdirSync(join(target, 'bin'), { recursive: true })
    copyFileSync(join(bundled, 'engram.exe'), join(target, 'engram.exe'))
    copyFileSync(join(bundled, SHIM), join(target, SHIM))
    writeFileSync(join(target, 'VERSION'), `${wanted}\n`, 'utf8')
    log(`MCP-половина разложена в ${target} (engram ${wanted})`)
    return { action: 'copied', target }
  } catch (error) {
    log(`MCP-половину не удалось обновить (${error.message}) — повторим при следующем запуске`)
    return { action: 'locked', target, error: error.message }
  }
}

/** Запись сервера в dsh-mcp.json — добавляется, только если её нет. */
export function ensureMcpServer(harness, { nodePath, shimPath, log = () => {} } = {}) {
  const configPath = join(harness, 'dsh-mcp.json')
  let document = { version: 1, servers: [] }
  if (existsSync(configPath)) {
    try {
      document = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (error) {
      log(`dsh-mcp.json не прочитан (${error.message}) — сервер не объявляю`)
      return { action: 'failed' }
    }
  }
  const servers = Array.isArray(document.servers) ? document.servers : []
  if (servers.some((server) => server?.name === MCP_NAME)) return { action: 'present' }
  const entry = { name: MCP_NAME, transport: 'stdio', command: nodePath, args: [shimPath], enabled: true }
  try {
    if (existsSync(configPath)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
      renameSync(configPath, `${configPath}.bak-${stamp}`)
    } else {
      mkdirSync(harness, { recursive: true })
    }
    writeFileSync(configPath, `${JSON.stringify({ ...document, version: document.version ?? 1, servers: [...servers, entry] }, null, 2)}\n`, 'utf8')
    log(`MCP-сервер ${MCP_NAME} объявлен в ${configPath} (нужен перезапуск десктопа)`)
    return { action: 'added' }
  } catch (error) {
    log(`MCP-сервер не объявлен (${error.message})`)
    return { action: 'failed', error: error.message }
  }
}

/** Оркестратор: разложить половину и объявить сервер. Ошибки наружу не летят. */
export function setupMcp(config = {}, { log = () => {}, pluginDir = '', env = process.env, execPath = process.execPath } = {}) {
  if (config.registerMcp === false) return { action: 'disabled' }
  const harness = harnessDir(config, env)
  if (harness === null) return { action: 'no-harness' }
  const bundled = bundledMcpDir(pluginDir)
  const nodePath = resolveNode(config, { env, execPath })
  const shimPath = join(harness, 'mcp', MCP_NAME, 'package', SHIM)
  return {
    package: ensureMcpPackage(harness, bundled, { log }),
    server: ensureMcpServer(harness, { nodePath, shimPath, log })
  }
}
