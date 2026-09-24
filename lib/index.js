// dsh-engram-memory — память engram в DSH: ведётся сама, без просьб.
//
// Пакет самодостаточен: MCP-половина (бинарь engram + шим) лежит внутри пакета,
// плагин сам раскладывает её в харнесс и сам объявляет сервер.
//
// Три части, как у рабочих плагинов памяти в DSH:
//   • правила живут в системном промпте (`ctx.systemPrompt.section`) — модель
//     всегда знает, что память есть, куда писать общее правило и как поднять
//     проектную запись в общий слой;
//   • на `agent/pre-step` релевантные записи той же базы
//     (`%USERPROFILE%\.engram\engram.db`) добавляются в ход в жёстком бюджете;
//   • законченный ход, который что-то сделал или что-то выяснил, сохраняется
//     сам — через CLI engram, без модели и без LLM;
//   • по команде `/memory-consolidate` сырые заметки проекта сводятся моделью
//     харнесса в карточки-выводы со ссылками на источники — обобщение стоит
//     токенов, поэтому запускается человеком, а не каждым ходом.
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
import { MCP_NAME, bundledMcpDir, harnessDir, mcpVersion, setupMcp } from './mcp-setup.js'
import { consolidate, renderReport } from './consolidate.js'
import { createHostModel, routeFromAgent } from './host-model.js'
import { createJob, panelStatistics, resolveRoute, sendJson, stateHandler } from './panel.js'

export const name = 'dsh-engram-memory'

// Служба промпта — единственная незаменимая: без неё правила памяти до модели
// не доедут, а инъекция и запись теряют смысл. Требование в `inject` не
// выключает плагин там, где служба есть (она в базовой поставке), но без него
// `ctx.systemPrompt` молча не существует — проверено живьём. Остальное
// (`commands`, `llm`, `webServer`, `workspaceRegistry`) подключается
// необязательно через `ctx.inject`: в профиле без веб-сервера память обязана
// работать так же, а вкладка настроек там просто не нужна.
export const inject = ['systemPrompt']

/**
 * Правила памяти для модели. Это часть системного промпта, а не скилл:
 * скиллы из файловой системы в этой сборке не загружаются, а секция доходит
 * до модели всегда.
 */
const GUIDANCE = [
  'Память (engram) подключена и ведётся автоматически.',
  '',
  '- Искать вручную не нужно: релевантные записи приходят в ход сами. Точный поиск — `mem_search` (`match_mode: "any"`), запись — `mem_save` (обязателен `title`, текст в `content`), не больше двух записей на задачу.',
  '- Уровни (`scope`): `project` — про этот воркспейс (`project` = имя папки проекта, сюда же пишет автосохранение ходов); `personal` — про пользователя и его предпочтения; `global` — конвенции, действующие в любом проекте. `personal` и `global` приходят во всех проектах, проектные записи — только в своём.',
  '- Общий слой наполняешь только ты: автосохранение ходов пишет лишь в проект. Писать `global` и `personal` — твоя штатная работа, разрешения спрашивать не нужно.',
  '- В `global`: оформление README и коммитов, соглашения об именах, стек и инструменты, которых держится пользователь, чего не делать в коде, повторяющиеся архитектурные решения. В `personal`: как пользователь предпочитает работать, его требования к ответам.',
  '- Правило, всплывшее внутри проекта, сначала сохрани в проект; когда оно пригодилось второй раз — подними его в общий слой (`mem_update` с `scope: "global"`). Так общий слой остаётся правилами, а не свалкой.',
  '- Если новое противоречит тому, что в памяти уже лежит, — обнови запись (`mem_update`), а не клади рядом вторую: старое должно быть вытеснено, а не спорить с новым.',
  '- Правило, которое должно переживать чистку памяти, помечай `mem_pin`.',
  '- Обобщай, а не только фиксируй: закончив работу, сохрани вывод — что теперь известно и как это делать (структура `What`, `Why`, `Where`, `Learned`). Обобщение типа `pattern`, `decision` или `architecture` ценнее сырой заметки хода: заметка говорит «что делали», вывод отвечает на вопрос в следующий раз.',
  '- Видишь, что тема обновлялась много раз, — сожми её в один вывод: хроника ходов нужна меньше, чем итог.',
  '- Не сохраняй пересказ чата, приветствия, состояние «делаю сейчас» и секреты (ключи, токены, пароли): только то, что пригодится в следующий раз.'
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

/**
 * Где лежит бинарь engram. Первым идёт свой, из пакета: пакет самодостаточен и
 * не зависит от того, положил ли кто-то бинарник в харнесс. Дальше — настройка,
 * потом копия MCP-сервера в харнессе (её версия может быть старше или новее).
 */
export function engramBinary(configured) {
  const candidates = []
  const here = typeof import.meta.dirname === 'string' ? import.meta.dirname : null
  if (here !== null) {
    candidates.push(join(here, '..', 'mcp', 'engram.exe'))
    candidates.push(join(here, '..', 'mcp', 'engram'))
  }
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    candidates.push(join(home, 'mcp', 'engram', 'package', 'engram.exe'))
    candidates.push(join(home, 'mcp', 'engram', 'package', 'engram'))
  }
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
    // По умолчанию запоминаем и работу, и разбор: исследовательский ход потом
    // экономит работу не меньше правки. `captureRequireChange: true` оставляет
    // только ходы с изменениями.
    captureRequireChange: config.captureRequireChange === true,
    captureResearch: config.captureResearch !== false,
    captureReadMin: Number.isFinite(config.captureReadMin) ? Number(config.captureReadMin) : 3,
    captureType: typeof config.captureType === 'string' ? config.captureType : 'discovery',
    engramPath: typeof config.engramPath === 'string' ? config.engramPath : '',
    // Самодостаточность пакета: плагин сам раскладывает MCP-половину в харнесс и
    // сам объявляет сервер. `registerMcp: false` выключает оба шага.
    registerMcp: config.registerMcp !== false,
    harnessDir: typeof config.harnessDir === 'string' ? config.harnessDir : '',
    nodePath: typeof config.nodePath === 'string' ? config.nodePath : '',
    // Подсказка об обобщении: тема, которую запись обновляла много раз, — это
    // работа, которая тянется. Напоминание стоит символов, а вывод из памяти
    // потом искать не надо.
    consolidateHint: config.consolidateHint !== false,
    consolidateMinRevisions: Number.isFinite(config.consolidateMinRevisions) ? Number(config.consolidateMinRevisions) : 3,
    // Обобщение по команде: сколько сырых заметок берём за проход, сколько
    // знаков отдаём модели, сколько ждём ответа и каким типом помечаем вывод.
    consolidate: config.consolidate !== false,
    consolidateNotes: Number.isFinite(config.consolidateNotes) ? Number(config.consolidateNotes) : 20,
    consolidateInputChars: Number.isFinite(config.consolidateInputChars) ? Number(config.consolidateInputChars) : 12000,
    // Проход идёт вне разговора, его можно отменить и он не мешает работе —
    // поэтому предел времени щедрый: модели и каналы бывают медленными.
    consolidateTimeoutMs: Number.isFinite(config.consolidateTimeoutMs) ? Number(config.consolidateTimeoutMs) : 300000,
    consolidateType: typeof config.consolidateType === 'string' ? config.consolidateType : 'pattern',
    // Явная модель для обработки. Пусто — берём модель по умолчанию из настроек DSH.
    consolidateProvider: typeof config.consolidateProvider === 'string' ? config.consolidateProvider : '',
    consolidateModel: typeof config.consolidateModel === 'string' ? config.consolidateModel : ''
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

  // Самодостаточность: свою копию MCP-половины раскладываем в харнесс и, если
  // сервера там ещё нет, объявляем его. Когда всё на месте — тихий no-op.
  try {
    const here = typeof import.meta.dirname === 'string' ? import.meta.dirname : ''
    const result = setupMcp(settings, {
      log: (message) => ctx.logger?.info?.(`${name}: ${message}`),
      pluginDir: here === '' ? '' : join(here, '..')
    })
    if (result?.package?.action === 'locked') warn('MCP-половина обновится после остановки сервера engram')
    if (result?.server?.action === 'added') warn('MCP-сервер объявлен заново — понадобится перезапуск десктопа')
  } catch (error) {
    warn(`подготовка MCP-половины не удалась: ${error.message}`)
  }

  // Обобщение памяти. Модель для прохода — та же модель харнесса: маршрут
  // берётся у агента, который получил команду, своих ключей плагин не заводит.
  // Проход не привязан к разговору, поэтому им же позже сможет управлять крон.
  const complete = createHostModel(ctx, {
    defaultTimeoutMs: settings.consolidateTimeoutMs,
    log: (message) => ctx.logger?.info?.(`${name}: ${message}`)
  })
  const completeFor = (route) => (messages, options) => complete(messages, { ...options, route })

  /** Запись карточки тем же путём, что и автосохранение: через CLI engram. */
  const saveCard = (args) =>
    new Promise((resolve, reject) => {
      const binary = engramBinary(settings.engramPath)
      if (binary === null) {
        reject(new Error('бинарь engram не найден'))
        return
      }
      const dataDir = dirname(store()?.path ?? databasePath(readSharedConfig()))
      try {
        const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore', env: captureEnv(dataDir) })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`engram завершился с кодом ${code}`))))
      } catch (error) {
        reject(error)
      }
    })

  const consolidateProject = ({ project, dryRun, route, signal }) =>
    consolidate({
      store: store(),
      project,
      dryRun,
      signal,
      complete: completeFor(route),
      save: saveCard,
      limit: settings.consolidateNotes,
      maxChars: settings.consolidateInputChars,
      kind: settings.consolidateType,
      timeoutMs: settings.consolidateTimeoutMs,
      log: (message) => ctx.logger?.info?.(`${name}: ${message}`)
    })

  // Команду объявляет сам плагин: интерфейс показывает её в списке команд вместе
  // со описанием. Основной путь для человека — вкладка настроек, команда остаётся
  // для тех, кто привык работать строкой.
  const registerCommand = (commands) => {
    if (!settings.consolidate || typeof commands?.register !== 'function') return
    try {
      const disposeCommand = commands.register({
        name: 'memory-consolidate',
        description: 'Обработать заметки: свести сырые заметки проекта в карточки-выводы со ссылками на источники',
        input: { hint: 'проект или «черновик» — показать вывод, ничего не записывая' },
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim()
          const dryRun = /^(dry|dry-run|черновик)$/i.test(raw)
          const header = invocation?.agent?.session?.header
          const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
          const explicit = raw !== '' && !dryRun ? raw.toLowerCase() : null
          const project = explicit ?? projectFor(cwd, store())
          if (project === null || project === undefined) {
            return { kind: 'error', text: 'Не понял проект: назовите его после команды, например «/memory-consolidate hrm1».' }
          }
          const route = processingRoute(routeFromAgent(invocation?.agent))
          if (route === undefined) {
            return { kind: 'error', text: 'Не выбрана модель: укажите модель по умолчанию в настройках DSH — ею обрабатываются заметки.' }
          }
          try {
            return { kind: 'success', text: renderReport(await consolidateProject({ project, dryRun, route, signal: invocation?.signal })) }
          } catch (error) {
            return { kind: 'error', text: `Обработать заметки не удалось: ${error?.message ?? error}` }
          }
        }
      })
      ctx.on('dispose', () => disposeCommand?.())
    } catch (error) {
      warn(`команду объявить не удалось: ${error.message}`)
    }
  }

  // ── вкладка настроек ───────────────────────────────────────────────────────
  // Клиентской половине нужны три вещи: сколько заметок не обработано, кнопка
  // запуска и состояние подключения MCP. Всё считает хост — база у него под рукой.

  const pluginDir = typeof import.meta.dirname === 'string' ? join(import.meta.dirname, '..') : ''

  /** Состояние подключения MCP: объявлен ли сервер и какая копия бинаря в харнессе. */
  const mcpStatus = () => {
    const empty = { declared: false, harnessVersion: null, packageVersion: null, needsRestart: false }
    try {
      const harness = harnessDir(settings)
      if (harness === null) return empty
      let declared = false
      const configPath = join(harness, 'dsh-mcp.json')
      if (existsSync(configPath)) {
        try {
          const document = JSON.parse(readFileSync(configPath, 'utf8'))
          declared = (Array.isArray(document.servers) ? document.servers : []).some((server) => server?.name === MCP_NAME)
        } catch {
          declared = false
        }
      }
      const harnessVersion = mcpVersion(join(harness, 'mcp', MCP_NAME, 'package'))
      const packageVersion = mcpVersion(bundledMcpDir(pluginDir))
      return {
        declared,
        harnessVersion,
        packageVersion,
        needsRestart: harnessVersion !== null && packageVersion !== null && harnessVersion !== packageVersion
      }
    } catch (error) {
      warn(`состояние MCP не прочитано: ${error.message}`)
      return empty
    }
  }

  // Воркспейс и маршрут модели запоминаем по ходу работы: это запасные источники
  // для вкладки, которая живёт вне разговора. Основной источник модели — настройка
  // «модель по умолчанию» из настроек DSH (служба agentDefaultModel).
  let lastWorkspace = ''
  let lastRoute
  let workspaceRoots = () => (lastWorkspace === '' ? [] : [lastWorkspace])
  let defaultSelection = () => undefined

  /** Модель обработки: настройка плагина → модель по умолчанию → модель сессии. */
  const processingRoute = (sessionRoute) =>
    resolveRoute({
      override: { provider: settings.consolidateProvider, model: settings.consolidateModel },
      defaultSelection: defaultSelection(),
      sessionRoute
    })

  /** Проект вкладки: тот, где идёт работа, затем воркспейсы, затем явная настройка. */
  const panelProject = () => {
    const db = store()
    const roots = [lastWorkspace, ...workspaceRoots()].filter((root, index, all) => root !== '' && all.indexOf(root) === index)
    for (const root of roots) {
      const project = projectFor(root, db)
      if (project !== null) return { project, workspace: root }
    }
    if (settings.project.trim() !== '') return { project: settings.project.trim().toLowerCase(), workspace: '' }
    return { project: null, workspace: '' }
  }

  /** Что показывает вкладка: статистика по базе, модель обработки, состояние прохода. */
  const panelState = async () => {
    const { project, workspace } = panelProject()
    const route = processingRoute(lastRoute)
    return {
      project,
      workspace,
      notes: panelStatistics(project === null ? null : store(), project),
      model: route === undefined ? null : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort ?? null },
      mcp: mcpStatus(),
      job: job.status()
    }
  }

  // Один проход обработки и три способа его запустить (кнопка, команда, позже
  // крон). Интерфейс не держит запрос открытым: проход ждёт модель, а состояние
  // он опрашивает — поэтому минута ожидания не выглядит зависанием.
  const job = createJob(
    async (signal) => {
      const { project } = panelProject()
      if (project === null) throw new Error('не понял проект: назовите его в настройках плагина')
      const route = processingRoute(lastRoute)
      if (route === undefined) throw new Error('не выбрана модель: укажите модель по умолчанию в настройках DSH')
      const result = await consolidateProject({ project, dryRun: false, route, signal })
      return { ...result, report: renderReport(result) }
    },
    { log: (message) => ctx.logger?.info?.(`${name}: ${message}`) }
  )

  const registerRoutes = (webServer) => {
    if (typeof webServer?.register !== 'function') return
    const disposers = [
      webServer.register({ kind: 'exact', path: '/engram-memory/state', handler: stateHandler(panelState) }),
      webServer.register({
        kind: 'exact',
        path: '/engram-memory/run',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'нужен POST' })
            return
          }
          const started = await job.start()
          sendJson(res, started.started ? 202 : 409, { ok: true, ...started })
        }
      }),
      webServer.register({
        kind: 'exact',
        path: '/engram-memory/cancel',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'нужен POST' })
            return
          }
          sendJson(res, 200, { ok: true, ...job.cancel() })
        }
      })
    ]
    ctx.on?.('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Снятие маршрута не должно ломать остановку плагина.
        }
      }
    })
  }

  // Необязательные службы: в профиле без них память работает как прежде, просто
  // без вкладки и без команды. Обязательный список `inject` из-за них не трогаем.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands', 'llm'], (injected) => registerCommand(injected.commands))
    ctx.inject(['webServer'], (injected) => registerRoutes(injected.webServer))
    ctx.inject(['workspaceRegistry'], (injected) => {
      workspaceRoots = () =>
        (injected.workspaceRegistry.list() ?? [])
          .map((workspace) => workspace?.path)
          .filter((path) => typeof path === 'string' && path !== '')
    })
    // Модель по умолчанию из настроек DSH — тот же выбор, что виден в разделе
    // «Модели». Вкладка живёт вне разговора, поэтому берёт модель отсюда.
    ctx.inject(['agentDefaultModel'], (injected) => {
      defaultSelection = () => {
        try {
          return injected.agentDefaultModel.currentSelection()
        } catch (error) {
          warn(`модель по умолчанию не прочитана: ${error.message}`)
          return undefined
        }
      }
    })
  } else {
    registerCommand(ctx.commands)
    if (ctx.webServer) registerRoutes(ctx.webServer)
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

    // Вкладка настроек открывается вне разговора, поэтому воркспейс и маршрут
    // модели запоминаем здесь: это единственное место, где видно и то, и другое.
    if (typeof header?.cwd === 'string' && header.cwd !== '') lastWorkspace = header.cwd
    const seenRoute = routeFromAgent(agent)
    if (seenRoute !== undefined) lastRoute = seenRoute

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
      research: settings.captureResearch,
      readMin: settings.captureReadMin,
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
    const text = formatInjection(picked, {
      budget: settings.budget,
      topK: settings.topK,
      cue: settings.consolidateHint,
      cueMinRevisions: settings.consolidateMinRevisions
    })
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
