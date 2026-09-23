// dsh-engram-bridge — хост-половина: память engram приходит в ход сама.
//
// Инструменты engram модель вызывает по своей инициативе, и в разговоре про
// прошлые решения она вспоминает о них не всегда. Здесь на `agent/pre-step`
// последнее сообщение пользователя превращается в поисковый запрос по той же
// базе (`%USERPROFILE%\.engram\engram.db`), и до двух записей в жёстком бюджете
// добавляются в ход. Тот же стор, что у MCP-сервера: пишет по-прежнему engram.
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  databasePath,
  formatInjection,
  openStore,
  readSharedConfig,
  searchObservations
} from './engram-store.js'

export const name = 'dsh-engram-bridge'

// Ни одна служба не обязательна: плагин работает и без них, а требование в
// статическом inject отключило бы его целиком там, где службы нет.
export const inject = []

let createUserMessage = null
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  createUserMessage = null
}

/**
 * Сообщение-инъекция. Собирается штатной фабрикой ядра, если она доступна:
 * сообщение должно быть полноценным user-сообщением с пометкой плагина,
 * иначе ядро отрисует его как реплику пользователя.
 */
function pluginMessage(text) {
  const source = { kind: 'plugin', plugin: name, form: 'memory-injection' }
  if (typeof createUserMessage === 'function') {
    return createUserMessage({ content: [{ type: 'text', text }], source })
  }
  return Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source })
}

/** Текст последнего настоящего сообщения пользователя: по нему строим запрос. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return null
}

/** Имя проекта: явный настройка → .engram/config.json → имя рабочего каталога. */
export function projectOf(cwd, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (typeof cwd === 'string' && cwd !== '') {
    const configPath = join(cwd, '.engram', 'config.json')
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
        const fromFile = parsed?.project ?? parsed?.name
        if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim()
      } catch {
        // Битый файл проекта не повод терять инъекцию: ниже возьмём имя каталога.
      }
    }
    const folder = basename(cwd)
    if (folder !== '') return folder
  }
  return null
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const settings = {
    budget: Number.isFinite(config.budget) ? Number(config.budget) : 1200,
    topK: Number.isFinite(config.topK) ? Number(config.topK) : 2,
    project: typeof config.project === 'string' ? config.project : ''
  }

  const manager = { path: null, db: null }
  const seenBySession = new Map()
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // Логирование не должно ломать ход.
    }
  }

  const store = () => {
    const path = databasePath(readSharedConfig())
    if (manager.db !== null && manager.path === path) return manager.db
    try {
      manager.db?.close?.()
    } catch {
      // Закрытие старого стора не критично.
    }
    manager.path = path
    manager.db = openStore(path)
    return manager.db
  }

  const seen = (sessionId) => {
    let set = seenBySession.get(sessionId)
    if (set === undefined) {
      set = new Set()
      seenBySession.set(sessionId, set)
      if (seenBySession.size > 200) {
        const oldest = seenBySession.keys().next().value
        seenBySession.delete(oldest)
      }
    }
    return set
  }

  const injectMemory = async ({ agent }, decision) => {
    if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : null
    if (messages === null || messages.length === 0) return decision
    const header = agent?.session?.header
    if (header?.origin === 'subagent') return decision

    const prompt = lastUserText(messages)
    if (prompt === null) return decision

    const sessionId = typeof header?.id === 'string' && header.id !== '' ? header.id : 'unknown'
    const project = projectOf(typeof header?.cwd === 'string' ? header.cwd : '', settings.project)
    if (project === null) return decision

    const db = store()
    if (db === null) return decision

    const already = seen(sessionId)
    const rows = searchObservations(db, { query: prompt, project, limit: settings.topK * 4 })
      .filter((row) => !already.has(row.id))
    const text = formatInjection(rows, { budget: settings.budget, topK: settings.topK })
    if (text === null) return decision

    const injected = rows.slice(0, settings.topK)
    for (const row of injected) already.add(row.id)

    const lastUserIndex = messages.findLastIndex((message) => message?.source?.kind === 'user')
    const rewritten = [...messages]
    rewritten.splice(lastUserIndex < 0 ? rewritten.length : lastUserIndex, 0, pluginMessage(text))
    return { ...decision, messages: rewritten }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      return await injectMemory(payload, decision)
    } catch (error) {
      warn(`инъекция не удалась, ход идёт без неё: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  ctx.on('dispose', () => {
    try {
      manager.db?.close?.()
    } catch {
      // Ничего осмысленного здесь уже не сделать.
    }
  })
}
