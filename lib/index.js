// dsh-engram-bridge — хост-половина: память engram ведётся сама, без просьб.
//
// Три части, как у рабочих плагинов памяти в DSH:
//   • правила живут в системном промпте (`ctx.systemPrompt.section`) — модель
//     всегда знает, что память есть и когда писать общее правило;
//   • на `agent/pre-step` релевантные записи той же базы
//     (`%USERPROFILE%\.engram\engram.db`) добавляются в ход в жёстком бюджете;
//   • законченный ход с изменениями файлов или командами и содержательным
//     итогом сохраняется сам — через CLI engram, без модели и без LLM.
// Пишет в базу всегда engram: плагин только читает и просит сохранить.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digestTurn, saveArgs } from './capture.js'
import {
  databasePath,
  formatInjection,
  openStore,
  pickInjectionRows,
  projectFromSessions,
  readSharedConfig,
  searchObservations
} from './engram-store.js'

export const name = 'dsh-engram-bridge'

// Служба промпта — единственная, которую плагин требует: без неё правила
// памяти до модели не доедут, а инъекция и запись теряют смысл. Требование в
// `inject` не выключает плагин там, где служба есть (она в базовой поставке),
// но без него `ctx.systemPrompt` молча не существует — проверено живьём.
export const inject = ['systemPrompt']

/**
 * Правила памяти для модели. Это часть системного промпта, а не скилл:
 * скиллы из файловой системы в этой сборке не загружаются, а секция доходит
 * до модели всегда.
 */
const GUIDANCE = [
  'Память проекта (engram) подключена и ведётся автоматически.',
  '',
  '- Искать вручную не нужно: релевантные записи приходят в ход сами. Для точного поиска есть инструменты engram — `mem_search` (со `match_mode: "any"`) и `mem_save`.',
  '- Записывать тоже можно самому: после проверенной работы, не больше двух записей на задачу. Обязателен `title`, текст — в `content`.',
  '- Уровни (`scope`): `project` — про этот воркспейс (по умолчанию, `project` = имя папки проекта); `personal` — про пользователя и его предпочтения; `global` — конвенции, действующие в любом проекте (оформление README и коммитов, чего не писать в коде).',
  '- Если пользователь в разговоре формулирует правило «так делать всегда» — сохрани его как `global`.',
  '- `personal` и `global` приходят во всех проектах, проектные записи — только в своём.',
  '- Не сохраняй пересказ чата, приветствия и состояние «делаю сейчас»: только то, что пригодится в следующий раз.'
].join('\n')

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

/** Где лежит бинарь engram: настройки → каталог MCP-сервера в поставке → рядом с плагином. */
export function engramBinary(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    candidates.push(join(home, 'mcp', 'engram', 'package', 'engram.exe'))
    candidates.push(join(home, 'mcp', 'engram', 'package', 'engram'))
  }
  const here = typeof import.meta.dirname === 'string' ? import.meta.dirname : null
  if (here !== null) {
    candidates.push(join(here, '..', 'engram.exe'))
    candidates.push(join(here, '..', 'vendor', 'engram-mcp', 'engram.exe'))
  }
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Окружение для CLI engram: тот же каталог данных, что читает плагин (иначе
 * запись уедет в другую базу), и выключенная проверка обновлений — запись
 * памяти не должна ходить в сеть.
 */
export function captureEnv(dataDir, base = process.env) {
  return { ...base, ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const settings = {
    budget: Number.isFinite(config.budget) ? Number(config.budget) : 1200,
    topK: Number.isFinite(config.topK) ? Number(config.topK) : 2,
    project: typeof config.project === 'string' ? config.project : '',
    capture: config.capture !== false,
    captureMinChars: Number.isFinite(config.captureMinChars) ? Number(config.captureMinChars) : 200,
    captureMaxChars: Number.isFinite(config.captureMaxChars) ? Number(config.captureMaxChars) : 2000,
    captureRequireChange: config.captureRequireChange !== false,
    captureType: typeof config.captureType === 'string' ? config.captureType : 'discovery',
    engramPath: typeof config.engramPath === 'string' ? config.engramPath : ''
  }

  const manager = { path: null, db: null }
  const seenBySession = new Map()
  // Темы, уже записанные в этой сессии: работа запоминается один раз, а не на
  // каждом шаге. Между сессиями повтор безвреден — engram обновляет запись по
  // теме (проверено: три записи с одной темой дают одну строку, revision_count 3).
  const capturedBySession = new Map()
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

  /** Темы, уже записанные в этой сессии. */
  const capturedTopics = (sessionId) => {
    let set = capturedBySession.get(sessionId)
    if (set === undefined) {
      set = new Set()
      capturedBySession.set(sessionId, set)
      if (capturedBySession.size > 200) {
        const oldest = capturedBySession.keys().next().value
        capturedBySession.delete(oldest)
      }
    }
    return set
  }

  /**
   * Имя проекта для записи и поиска. Явные настройки уважаем как есть; иначе
   * берём имя, которым engram зовёт этот рабочий каталог (так его зовут
   * инструменты MCP), и лишь затем имя папки. Регистр не важен: engram хранит
   * проекты в нижнем.
   */
  const projectFor = (cwd, db) => {
    const fallback = projectOf(cwd, settings.project)
    if (fallback === null) return null
    return (settings.project.trim() !== '' ? fallback : projectFromSessions(db, cwd) ?? fallback).toLowerCase()
  }

  /**
   * Что нужно обеим половинам: история хода, проект и открытая база.
   * Пока это не собралось — ход идёт как есть.
   */
  const stepContext = ({ agent }, decision) => {
    if (decision === undefined || decision === null || decision.kind !== 'enter') return null
    const messages = Array.isArray(decision.messages) ? decision.messages : null
    if (messages === null || messages.length === 0) return null
    const header = agent?.session?.header
    if (header?.origin === 'subagent') return null

    const sessionId = typeof header?.id === 'string' && header.id !== '' ? header.id : 'unknown'
    const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
    const db = store()
    if (db === null) return null
    const project = projectFor(cwd, db)
    if (project === null) return null

    return { messages, sessionId, cwd, project, db }
  }

  /**
   * Автосохранение хода. Числа и текст берутся из истории, а не из модели:
   * если в ходе менялись файлы или выполнялись команды и есть содержательный
   * итог — запись уходит в engram через CLI, вне хода.
   *
   * `turn` — какой ход разбираем: `previous` (всё до последней реплики
   * пользователя: так видно на pre-step) или `current` (ход целиком: так видно
   * на `turn/end`, когда разбирать больше нечего).
   */
  const captureTurn = (state, turn = 'previous') => {
    if (!settings.capture) return
    const record = digestTurn(state.messages, {
      minSummary: settings.captureMinChars,
      maxChars: settings.captureMaxChars,
      requireChange: settings.captureRequireChange,
      project: state.project,
      type: settings.captureType,
      turn
    })
    if (record === null) return

    const topics = capturedTopics(state.sessionId)
    if (topics.has(record.topic)) return

    const binary = engramBinary(settings.engramPath)
    if (binary === null) {
      settings.capture = false
      warn('бинарь engram не найден — автосохранение выключено')
      return
    }

    topics.add(record.topic)

    // Тот же каталог данных, что читает плагин: иначе запись уедет в другую базу.
    const dataDir = dirname(state.db?.path ?? databasePath(readSharedConfig()))
    try {
      const child = spawn(binary, saveArgs(record), {
        windowsHide: true,
        stdio: 'ignore',
        env: captureEnv(dataDir)
      })
      child.on('error', (error) => warn(`автосохранение не удалось: ${error.message}`))
      child.unref?.()
    } catch (error) {
      warn(`автосохранение не удалось: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Инъекция памяти в ход: релевантные записи перед последней репликой. */
  const injectMemory = (state, decision) => {
    const prompt = lastUserText(state.messages)
    if (prompt === null) return decision

    const already = seen(state.sessionId)
    const rows = searchObservations(state.db, { query: prompt, project: state.project, limit: settings.topK * 6 })
      .filter((row) => !already.has(row.id))
    const picked = pickInjectionRows(rows, settings.topK)
    const text = formatInjection(picked, { budget: settings.budget, topK: settings.topK })
    if (text === null) return decision

    for (const row of picked) already.add(row.id)

    const lastUserIndex = state.messages.findLastIndex((message) => message?.source?.kind === 'user')
    const rewritten = [...state.messages]
    rewritten.splice(lastUserIndex < 0 ? rewritten.length : lastUserIndex, 0, pluginMessage(text))
    return { ...decision, messages: rewritten }
  }

  // Правила памяти: секция системного промпта. Нет службы — нет секции,
  // плагин продолжает работать.
  try {
    ctx.systemPrompt?.section?.({
      name: `tool:${name}`,
      order: 116,
      text: GUIDANCE
    })
  } catch (error) {
    warn(`секция промпта не подключилась: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    let state = null
    try {
      state = stepContext(payload, decision)
    } catch (error) {
      warn(`контекст хода не собрался: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
    if (state === null) return decision

    try {
      captureTurn(state)
    } catch (error) {
      warn(`автосохранение не удалось: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return injectMemory(state, decision)
    } catch (error) {
      warn(`инъекция не удалась, ход идёт без неё: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // Ход по событиям сессии: `turn/end` — единственный момент, когда ход
  // закончился и его ещё есть из чего собрать. Без этого последняя работа в
  // сессии не запоминалась бы никогда: pre-step видит только прошлый ход.
  const turnBuffers = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (type !== 'user/message' && type !== 'assistant/message' && type !== 'turn/end') return
      const sessionId = typeof session?.id === 'string' && session.id !== '' ? session.id : null
      if (sessionId === null) return

      if (type === 'user/message') {
        // Реплика пользователя начинает ход; инъекция плагина и служебные
        // напоминания ход не начинают.
        if (event.data?.source?.kind !== 'user') return
        turnBuffers.set(sessionId, [event.data])
        if (turnBuffers.size > 200) {
          const oldest = turnBuffers.keys().next().value
          turnBuffers.delete(oldest)
        }
        return
      }

      const buffer = turnBuffers.get(sessionId)
      if (buffer === undefined) return
      if (type === 'assistant/message') {
        const message = event.data?.message
        if (message?.role === 'assistant') buffer.push(message)
        return
      }

      turnBuffers.delete(sessionId)
      const header = session?.header
      if (header?.origin === 'subagent') return
      const db = store()
      if (db === null) return
      const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
      const project = projectFor(cwd, db)
      if (project === null) return
      captureTurn({ messages: buffer, sessionId, cwd, project, db }, 'current')
    } catch (error) {
      warn(`разбор хода не удался: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('session/disposed', (session) => {
    if (typeof session?.id === 'string') turnBuffers.delete(session.id)
  })

  ctx.on('dispose', () => {
    try {
      manager.db?.close?.()
    } catch {
      // Ничего осмысленного здесь уже не сделать.
    }
  })
}
