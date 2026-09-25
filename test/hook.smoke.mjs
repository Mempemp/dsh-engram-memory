// Проверка хост-половины: плагин поднимает pre-step, инжектит в бюджет,
// не повторяет одну запись в рамках сессии и молча пропускает ход, когда
// памяти нет или включить нечего.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, captureEnv, inject, parseConsolidateInput, projectOf } from '../lib/index.js'
import { currentProjectFile, readCurrentProject } from '../lib/mcp-setup.js'
import { formatInjection } from '../lib/engram-store.js'
import { createStore, openReadOnly } from './_engram-fixture.mjs'

const contexts = []
let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'engram-hook-'))
// Снимок «где сейчас работаем» плагин пишет в LocalAppData: настоящий каталог
// не трогаем, уводим его в temp.
process.env.LOCALAPPDATA = join(root, 'localappdata')
const workspace = join(root, 'demo')
mkdirSync(workspace, { recursive: true })
createStore(
  [
    { title: 'Диаризация в Минутмейстере', content: 'Узкое место — WeSpeaker, 97% времени', project: 'demo' },
    { title: 'Чанки для ASR', content: 'При 413 режем аудио на чанки не длиннее 900 секунд', project: 'demo' }
  ],
  { dir: workspace }
)
const emptyDir = join(root, 'empty')
mkdirSync(emptyDir)

/** Конфиг шима MCP — тот же файл читает плагин, поэтому путь задаём через него. */
function pointAt(dir) {
  const configPath = join(root, `engram-${dir.endsWith('empty') ? 'empty' : 'workspace'}.json`)
  writeFileSync(configPath, JSON.stringify({ dataDir: dir.replaceAll('\\', '/') }), 'utf8')
  process.env.ENGRAM_MCP_CONFIG = configPath
}

/**
 * Ядро DSH не отдаёт службу с контекста, который её не подключил: обращение к
 * `ctx.llm` без `inject` падает с «cannot get property "llm" without inject».
 * Проверки повторяют это правило — иначе такая ошибка видна только живьём.
 */
const SERVICE_NAMES = ['systemPrompt', 'commands', 'llm', 'webServer', 'workspaceRegistry', 'agentDefaultModel']
function guarded(target, allowed) {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && SERVICE_NAMES.includes(property) && !allowed.has(property)) {
        throw new Error(`cannot get property "${property}" without inject`)
      }
      return object[property]
    }
  })
}

/**
 * Контекст плагина. `harnessDir` уводим в temp: самодостаточность пакета
 * раскладывает MCP-половину в харнесс, и тесты не должны трогать настоящий.
 */
function makeContext(config, options = {}) {
  const listeners = new Map()
  const warnings = []
  const sections = []
  const registered = []
  const routes = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return { dispose: () => {} }
      }
    },
    // Служба команд: в ней плагин объявляет кнопку обработки. Заглушка повторяет
    // контракт DSH — имя, описание, подсказка ввода и обработчик.
    commands: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      }
    },
    // Служба модели нужна только для необязательной регистрации команды и
    // обработки заметок; в этих проверках её не зовут.
    llm: { prepareCall: () => {} },
    // Веб-сервер и воркспейсы — тоже необязательные: без них плагин работает,
    // просто без вкладки настроек.
    webServer: {
      register: (spec) => {
        routes.push(spec)
        return () => {}
      }
    },
    workspaceRegistry: { list: () => [{ path: workspace }] },
    // Модель по умолчанию — тот же выбор, что в разделе «Модели»: вкладка берёт
    // модель отсюда, а не у последней сессии.
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    inject: (services, callback) => {
      const missing = services.filter((service) => ctx[service] === undefined)
      if (missing.length === 0) callback(guarded(ctx, new Set(services)))
    },
    on: (event, handler) => {
      const existing = listeners.get(event)
      if (existing === undefined) listeners.set(event, [handler])
      else existing.push(handler)
    }
  }
  // Проверки «службы нет»: вкладка не должна тянуть за собой обязательные службы.
  // Службу убираем ДО применения — иначе необязательная подписка уже сработала бы.
  if (options.noDefaultModel === true) delete ctx.agentDefaultModel
  if (options.noWebServer === true) delete ctx.webServer
  // Обращения к службам идут так же, как в ядре: что объявлено в `inject`
  // плагина — доступно, остальное только через `ctx.inject`.
  const outer = guarded(ctx, new Set(inject))
  apply(outer, { harnessDir: join(root, 'harness'), ...config })
  const context = {
    raw: outer,
    preStep: listeners.get('agent/pre-step')?.[0],
    fire: (event, ...args) => (listeners.get(event) ?? []).forEach((handler) => handler(...args)),
    dispose: listeners.get('dispose')?.[0],
    sections,
    warnings,
    commands: registered,
    routes
  }
  contexts.push(context)
  return context
}

const userMessage = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const payloadFor = (header) => ({ agent: { session: { header } } })
const call = (preStep, payload, decision) => preStep(payload, async () => decision)

console.log('== определение проекта ==')
check('явный настройки важнее каталога', projectOf(workspace, 'explicit') === 'explicit')
check('файл .engram/config.json учитывается', (() => {
  mkdirSync(join(workspace, '.engram'), { recursive: true })
  writeFileSync(join(workspace, '.engram', 'config.json'), JSON.stringify({ project: 'from-file' }), 'utf8')
  const result = projectOf(workspace, '') === 'from-file'
  rmSync(join(workspace, '.engram'), { recursive: true, force: true })
  return result
})())
check('иначе — имя каталога', projectOf(workspace, '') === 'demo', projectOf(workspace, ''))
check('без cwd проект не выдумывается', projectOf('', '') === null)

console.log('\n== окружение автосохранения ==')
const spawnEnv = captureEnv('C:/data', { PATH: 'x', ENGRAM_DATA_DIR: 'C:/other' })
check('данные берутся из каталога плагина', spawnEnv.ENGRAM_DATA_DIR === 'C:/data', spawnEnv.ENGRAM_DATA_DIR)
check('проверка обновлений выключена (запись не ходит в сеть)', spawnEnv.ENGRAM_NO_UPDATE_CHECK === '1')
check('остальное окружение сохранено', spawnEnv.PATH === 'x')

console.log('\n== инъекция в ход ==')
pointAt(workspace)
const { preStep } = makeContext({})
const header = { id: 'session-1', cwd: workspace, origin: 'main' }
const decision = { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] }
const injected = await call(preStep, payloadFor(header), decision)

check('ход вернулся, а не подменён', injected.kind === 'enter')
check('добавилось ровно одно сообщение', injected.messages.length === 2, String(injected.messages.length))
check('сообщение стоит перед репликой пользователя', injected.messages[1] === decision.messages[0])

console.log('\n== снимок «где работаем» для прокладки MCP ==')
check('снимок записан при первом же ходу', readCurrentProject() === 'demo', String(readCurrentProject()))
check('снимок лежит в LocalAppData', currentProjectFile() === join(root, 'localappdata', 'DSH-1C', 'engram-current-project.json'), String(currentProjectFile()))
const snapshot = existsSync(currentProjectFile()) ? readFileSync(currentProjectFile(), 'utf8') : ''
check('в снимке назван рабочий каталог', snapshot !== '' && JSON.parse(snapshot).workspace === workspace, snapshot.slice(0, 140))
check('это сообщение плагина', injected.messages[0].source?.plugin === 'dsh-engram-memory', JSON.stringify(injected.messages[0].source))
check('роль — user', injected.messages[0].role === 'user')
const text = injected.messages[0].content[0].text
check('в инъекции нашлась запись про диаризацию', text.includes('Диаризация'), text.slice(0, 120))
check('инъекция в бюджете 1200', text.length <= 1200, String(text.length))
check('исходный массив не переписан на месте', decision.messages.length === 1)

console.log('\n== дедупликация и границы ==')
const again = await call(preStep, payloadFor(header), { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] })
check('в той же сессии повторная запись не инжектится', again.messages.length === 1, String(again.messages.length))
const otherSession = await call(preStep, payloadFor({ ...header, id: 'session-2' }), { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] })
check('новая сессия получает память снова', otherSession.messages.length === 2, String(otherSession.messages.length))
const subagent = await call(preStep, payloadFor({ ...header, id: 'session-3', origin: 'subagent' }), { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] })
check('субагент память не получает', subagent.messages.length === 1)
const noUser = await call(preStep, payloadFor(header), { kind: 'enter', messages: [{ source: { kind: 'plugin' }, content: [{ type: 'text', text: 'диаризация' }] }] })
check('без реплики пользователя запроса нет', noUser.messages.length === 1)
const empty = await call(preStep, payloadFor(header), { kind: 'enter', messages: [userMessage('и в на')] })
check('запрос из одних стоп-слов ничего не даёт', empty.messages.length === 1)

console.log('\n== отказы без последствий ==')
pointAt(emptyDir)
const noDb = await call(preStep, payloadFor({ id: 'session-4', cwd: workspace, origin: 'main' }), { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] })
check('без базы ход не меняется', noDb.messages.length === 1)
pointAt(workspace)
const tiny = makeContext({ budget: 40 })
const tight = await call(tiny.preStep, payloadFor({ id: 'session-5', cwd: workspace, origin: 'main' }), { kind: 'enter', messages: [userMessage('как ускорить диаризацию?')] })
check('тугой бюджет — инъекции нет', tight.messages.length === 1)
const off = makeContext({ enabled: false })
check('enabled: false отключает плагин целиком', off.preStep === undefined)
check('падений не залогировано', (tiny.warnings.length === 0), tiny.warnings.join('; '))

console.log('\n== проект: регистр и имя из сессий engram ==')
const pixelDir = join(root, 'PixerArtist')
mkdirSync(pixelDir, { recursive: true })
createStore(
  [{ title: 'Обзор репозитория', content: 'Пайплайн агента-художника, Aseprite MCP', project: 'pixerartist' }],
  { dir: pixelDir }
)
pointAt(pixelDir)
const pixel = makeContext({})
const pixelDecision = await call(pixel.preStep, payloadFor({ id: 'session-pixel', cwd: pixelDir, origin: 'main' }), {
  kind: 'enter',
  messages: [userMessage('что за репо pixerartist?')]
})
check('проект с заглавными буквами в имени папки находится', pixelDecision.messages.length === 2, String(pixelDecision.messages.length))

const mappedDir = join(root, 'Mapped')
mkdirSync(mappedDir, { recursive: true })
createStore(
  [{ title: 'Запись под именем engram', content: 'Проект назван иначе, чем папка воркспейса', project: 'engram-name' }],
  { dir: mappedDir, sessions: [{ id: 's-map', project: 'engram-name', directory: mappedDir }] }
)
pointAt(mappedDir)
const mapped = makeContext({})
const mappedDecision = await call(mapped.preStep, payloadFor({ id: 'session-map', cwd: mappedDir, origin: 'main' }), {
  kind: 'enter',
  messages: [userMessage('что там с проектом?')]
})
check(
  'имя проекта берётся из сессий engram, а не из имени папки',
  mappedDecision.messages.length === 2 && mappedDecision.messages[0].content[0].text.includes('Запись под именем engram'),
  mappedDecision.messages[0]?.content?.[0]?.text?.slice(0, 80) ?? `сообщений: ${mappedDecision.messages.length}`
)

console.log('\n== общие записи: чужие проектные не проходят, personal/global проходят ==')
const scopedDir = join(root, 'Scoped')
mkdirSync(scopedDir, { recursive: true })
createStore(
  [
    { title: 'Своя проектная запись', content: 'Правило проекта, только для этой папки', project: 'scoped' },
    { title: 'Чужая проектная запись', content: 'Правило проекта, к этой папке не относится', project: 'scopedx' },
    { title: 'Общее правило', content: 'Правило, действующее во всех проектах', project: 'scopedx', scope: 'global' }
  ],
  { dir: scopedDir, sessions: [{ id: 's-scoped', project: 'scoped', directory: scopedDir }] }
)
pointAt(scopedDir)
const scoped = makeContext({})
const scopedDecision = await call(scoped.preStep, payloadFor({ id: 'session-scoped', cwd: scopedDir, origin: 'main' }), {
  kind: 'enter',
  messages: [userMessage('какие правила проекта тут?')]
})
const scopedText = scopedDecision.messages[0]?.content?.[0]?.text ?? ''
check('своя проектная запись инжектится', scopedText.includes('Своя проектная запись'), scopedText.slice(0, 120))
check('чужая проектная запись не инжектится', !scopedText.includes('Чужая проектная запись'))
check('запись уровня global приходит с пометкой', scopedText.includes('·общее') && scopedText.includes('Общее правило'))

console.log('\n== общий слой держит место в бюджете ==')
const priorityDir = join(root, 'Priority')
mkdirSync(priorityDir, { recursive: true })
createStore(
  [
    {
      title: 'Правило проекта №1',
      content: 'Регион регион регион регион регион регион регион регион регион регион регион регион',
      project: 'priority'
    },
    {
      title: 'Правило проекта №2',
      content: 'Регион регион регион регион регион регион регион регион регион регион регион регион',
      project: 'priority'
    },
    { title: 'Общая конвенция', content: 'Правило про регион для всех проектов', project: 'other', scope: 'global' }
  ],
  { dir: priorityDir, sessions: [{ id: 's-priority', project: 'priority', directory: priorityDir }] }
)
pointAt(priorityDir)
const priority = makeContext({})
const priorityDecision = await call(
  priority.preStep,
  payloadFor({ id: 'session-priority', cwd: priorityDir, origin: 'main' }),
  { kind: 'enter', messages: [userMessage('что у нас по региону?')] }
)
const priorityText = priorityDecision.messages[0]?.content?.[0]?.text ?? ''
check('общая запись попала в инъекцию несмотря на ранг', priorityText.includes('·общее') && priorityText.includes('Общая конвенция'), priorityText.slice(0, 140))
check('проектная запись тоже на месте', priorityText.includes('Правило проекта'), priorityText.slice(0, 140))
check('больше двух записей не приходит', priorityText.split('\n- [').length - 1 === 2, String(priorityText.split('\n- [').length - 1))

console.log('\n== автосохранение хода ==')
const captureDir = join(root, 'Captured')
mkdirSync(captureDir, { recursive: true })
pointAt(captureDir)
const engramBinary = process.env.ENGRAM_BINARY ??
  'D:/cursor projects/DSH-1C-deskop-bundle/vendor/engram-mcp/engram.exe'
if (!existsSync(engramBinary)) {
  console.log(`  skip бинарь engram не найден (${engramBinary}) — проверка автосохранения пропущена`)
} else {
  // Базу создаёт сам engram: фикстура годится для чтения, но её схема не
  // принимает upsert-записи (в настоящей таблице есть ключи и ограничения).
  const bootstrap = spawnSync(
    engramBinary,
    ['save', 'База проекта создана', 'Служебная запись: база создана engram.', '--project', 'captured'],
    { env: { ...process.env, ENGRAM_DATA_DIR: captureDir }, encoding: 'utf8' }
  )
  if (bootstrap.status !== 0) {
    console.log(`  skip engram не создал базу: ${String(bootstrap.stderr).trim().slice(0, 160)}`)
  } else {
    const capturing = makeContext({ engramPath: engramBinary })
    const summary = 'Разобрал выбор региона по времени регистрации: МИНИМУМ по дате, при равенстве ' +
      'берём регион последней записи. Поправил запрос в ObjectModule.bsl, добавил проверку пустого ' +
      'результата и тестовый пример на две записи с одной датой.'
    const turn = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'поправь выбор региона' }] },
      {
        role: 'assistant',
        source: { kind: 'model' },
        content: [
          { type: 'tool-call', id: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'ObjectModule.bsl' }) },
          { type: 'text', text: summary }
        ]
      },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'теперь про другое: как дела с памятью?' }] }
    ]
    await call(capturing.preStep, payloadFor({ id: 'session-capture', cwd: captureDir, origin: 'main' }), {
      kind: 'enter',
      messages: turn
    })
    const dbPath = join(captureDir, 'engram.db')
    let row = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const probe = openReadOnly(dbPath)
        row = probe
          .prepare("SELECT title, content FROM observations WHERE project = 'captured' AND title LIKE 'Разобрал%' ORDER BY id DESC LIMIT 1")
          .get()
        probe.close()
      } catch {
        row = null
      }
      if (row !== undefined && row !== null) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    check('запись хода дошла до базы через engram', row !== undefined && row !== null, 'записи с итогом хода нет')
    if (row !== undefined && row !== null) {
      check('заголовок — из итога хода', String(row.title).startsWith('Разобрал выбор региона'), String(row.title))
      check('в записи есть файл хода', String(row.content).includes('ObjectModule.bsl'))
    }
  }
}

console.log('\n== строка инъекции показывает итог, а не запрос ==')
const capturedRow = {
  id: 42,
  title: 'Собрал релизный пак машин',
  scope: 'project',
  content: 'Запрос: собери пак\n\nИтог: Пак собран, проверены контрольные суммы\n\nФайлы: pack.json'
}
const capturedLine = formatInjection([capturedRow], { budget: 1200, topK: 1 }) ?? ''
check('в инъекции итог, а не запрос', capturedLine.includes('Пак собран') && !capturedLine.includes('Запрос:'), capturedLine)
const plainLine = formatInjection([{ id: 1, title: 'Заметка', content: 'Первая строка без структуры' }], { budget: 1200, topK: 1 }) ?? ''
check('обычная запись показывается как раньше', plainLine.includes('Первая строка без структуры'), plainLine)

console.log('\n== правила памяти доезжают до модели ==')
check('плагин требует службу промпта (иначе ctx.systemPrompt молча нет)', inject.includes('systemPrompt'), JSON.stringify(inject))
check('в проверках контекст такой же строгий, как в ядре', (() => {
  try {
    makeContext({}).raw.llm
    return false
  } catch (error) {
    return String(error.message).includes('without inject')
  }
})(), 'службу достали с голого контекста')
const guided = makeContext({})
const guidance = guided.sections.find((spec) => typeof spec.text === 'string' && spec.text.includes('Память (engram)'))
check('секция промпта зарегистрирована', guidance !== undefined)
check('в правилах есть уровни памяти', (guidance?.text ?? '').includes('`global`'), (guidance?.text ?? '').slice(0, 80))
check('секция не подменяет промпт целиком', guidance?.complete !== true)
check('модели прямо сказано, что общий слой наполняет она', (guidance?.text ?? '').includes('Общий слой наполняешь только ты'))
check('есть как поднять проектное правило в общий слой', (guidance?.text ?? '').includes('mem_update'))
check('сказано про секреты', (guidance?.text ?? '').includes('секреты'))
check('есть правило вытеснения, а не дублирования', (guidance?.text ?? '').includes('вытеснено'))
check('модели сказано, что проект подставляется сам', (guidance?.text ?? '').includes('Проект записей подставляется сам'))

console.log('\n== ход записывается на turn/end (а не только на следующем вопросе) ==')
const turnDir = join(root, 'TurnEnd')
mkdirSync(turnDir, { recursive: true })
pointAt(turnDir)
if (!existsSync(engramBinary)) {
  console.log('  skip бинарь engram не найден — проверка записи по turn/end пропущена')
} else {
  const boot = spawnSync(
    engramBinary,
    ['save', 'База хода создана', 'Служебная запись.', '--project', 'turnend'],
    { env: { ...process.env, ENGRAM_DATA_DIR: turnDir }, encoding: 'utf8' }
  )
  if (boot.status !== 0) {
    console.log(`  skip engram не создал базу: ${String(boot.stderr).trim().slice(0, 160)}`)
  } else {
    const turning = makeContext({ engramPath: engramBinary })
    const turnSummary = 'Довёл выбор региона до конца: регион берётся по времени регистрации, при равных датах — ' +
      'последняя запись. Поправил ObjectModule.bsl, прогнал проверку на двух записях с одной датой и убедился, ' +
      'что пустой результат больше не ломает шаблон.'
    const session = { id: 'session-turn', header: { cwd: turnDir, origin: 'main' } }
    turning.fire('session/event', session, { type: 'user/message', data: userMessage('доведи выбор региона') })
    turning.fire('session/event', session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'ObjectModule.bsl' }) },
            { type: 'text', text: turnSummary }
          ]
        }
      }
    })
    turning.fire('session/event', session, { type: 'turn/end', data: { turn: 1 } })

    let row = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const probe = openReadOnly(join(turnDir, 'engram.db'))
        row = probe
          .prepare("SELECT title FROM observations WHERE project = 'turnend' AND title LIKE 'Довёл%' ORDER BY id DESC LIMIT 1")
          .get()
        probe.close()
      } catch {
        row = null
      }
      if (row !== undefined && row !== null) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    check('ход записан сразу по turn/end', row !== undefined && row !== null, 'записи нет')

    const countTopic = () => {
      try {
        const probe = openReadOnly(join(turnDir, 'engram.db'))
        const stats = probe
          .prepare("SELECT count(*) AS rows, max(revision_count) AS revisions FROM observations WHERE project = 'turnend' AND topic_key LIKE '%довёл%'")
          .get()
        probe.close()
        return { rows: stats?.rows ?? 0, revisions: stats?.revisions ?? 0 }
      } catch {
        return { rows: -1, revisions: -1 }
      }
    }

    // Тот же ход повторился (второй раз) — плагин не должен звать запись снова:
    // работа про одну тему запоминается один раз за сессию.
    turning.fire('session/event', session, { type: 'user/message', data: userMessage('доведи выбор региона') })
    turning.fire('session/event', session, {
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: turnSummary }] } }
    })
    turning.fire('session/event', session, { type: 'turn/end', data: { turn: 2 } })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const repeated = countTopic()
    check('повторный turn/end не пишет запись второй раз', repeated.rows === 1 && repeated.revisions === 1, JSON.stringify(repeated))

    // Страховочный pre-step про ТОТ ЖЕ ход: раз turn/end его уже записал, второй
    // записи быть не должно — ни новой строки, ни новой ревизии.
    await call(turning.preStep, payloadFor({ id: 'session-turn', cwd: turnDir, origin: 'main' }), {
      kind: 'enter',
      messages: [
        userMessage('доведи выбор региона'),
        {
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            { type: 'tool-call', id: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'ObjectModule.bsl' }) },
            { type: 'text', text: turnSummary }
          ]
        },
        userMessage('теперь другое')
      ]
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const afterStep = countTopic()
    check('pre-step про уже записанный ход вторую запись не делает', afterStep.rows === 1 && afterStep.revisions === 1, JSON.stringify(afterStep))
  }
}

console.log('\n== кнопка «Обработать заметки» ==')
{
  pointAt(workspace)
  const commanded = makeContext({})
  const byName = (name) => commanded.commands.find((item) => item.name === name)
  const command = byName('memory-consolidate')
  check('команды объявлены интерфейсу', command !== undefined && commanded.commands.length === 3, `объявлено ${commanded.commands.length}`)
  check('имя команды — memory-consolidate', command?.name === 'memory-consolidate', String(command?.name))
  check('в описании то же название, что на кнопке', /Обработать заметки/.test(String(command?.description)), String(command?.description))
  check('подсказка ввода объясняет аргументы', typeof command?.input?.hint === 'string' && command.input.hint !== '', String(command?.input?.hint))
  check('обработчик — функция', typeof command?.handler === 'function')
  check('обязательный список служб не расширен', JSON.stringify(inject) === '["systemPrompt"]', inject.join(','))
  const hygiene = byName('memory-hygiene')
  const cleanup = byName('memory-cleanup')
  check('гигиена объявлена своими командами', hygiene !== undefined && cleanup !== undefined)
  check('отчёт гигиены считает по базе', /Усвоено выводами:/.test(String(hygiene?.description)) === false && /состояние памяти/.test(String(hygiene?.description)), String(hygiene?.description))
  check('уборка обещает мягкое удаление, а не удаление', /мягко/u.test(String(cleanup?.description)) && /жёстк/u.test(String(cleanup?.description)) === false, String(cleanup?.description))
  const report = await hygiene.handler({})
  check('отчёт выдаёт числа без модели', report?.kind === 'success' && /Сведены в выводы: \d+/.test(String(report.text)) && /Ждут сведения в выводы: \d+/.test(String(report.text)), JSON.stringify(report))
  const nothingToClean = await cleanup.handler({})
  check('когда убирать нечего, уборка так и говорит', nothingToClean?.kind === 'success' && /Убирать нечего|Убрано из обращения/.test(String(nothingToClean.text)), JSON.stringify(nothingToClean))
  const modelLess = makeContext({}, { noDefaultModel: true })
  const noModel = await modelLess.commands.find((item) => item.name === 'memory-consolidate').handler({ rawInput: 'demo', agent: {}, signal: undefined })
  check('без модели команда просит задать её в настройках', noModel?.kind === 'error' && String(noModel.text).includes('модель по умолчанию'), JSON.stringify(noModel))
  const nowhere = await command.handler({ rawInput: 'черновик нет-заметок', agent: {}, signal: undefined })
  check('без несведённых заметок команда модель не зовёт', nowhere?.kind === 'success' && String(nowhere.text).includes('несведённых заметок нет'), JSON.stringify(nowhere))
  // Проход доходит до службы модели. Здесь ловится ядровая строгость: с голого
  // контекста службу не достать, и ошибка была бы «cannot get property "llm" without inject».
  const reachesModel = await command.handler({ rawInput: 'demo', agent: {}, signal: undefined })
  check('проход дозвонился до службы модели, а не упал на её получении', String(reachesModel?.text ?? '').includes('without inject') === false, JSON.stringify(reachesModel))
  const silent = makeContext({ consolidate: false })
  check('обработка выключается настройкой, гигиена остаётся', silent.commands.length === 2 && silent.commands.every((item) => item.name !== 'memory-consolidate'), `объявлено ${silent.commands.length}`)
}

console.log('\n== разбор аргументов команды ==')
check('пустой ввод — все проекты без сужения', JSON.stringify(parseConsolidateInput('')) === JSON.stringify({ dryRun: false, project: null }), JSON.stringify(parseConsolidateInput('')))
check('имя проекта сужает проход', parseConsolidateInput('hrm1').project === 'hrm1' && parseConsolidateInput('hrm1').dryRun === false)
check('«черновик» — показ без записи', parseConsolidateInput('черновик').dryRun === true && parseConsolidateInput('черновик').project === null)
check('«черновик» и проект вместе', parseConsolidateInput('черновик hrm1').dryRun === true && parseConsolidateInput('черновик hrm1').project === 'hrm1', JSON.stringify(parseConsolidateInput('черновик hrm1')))
check('латинский dry понимается так же', parseConsolidateInput('dry hrm1').dryRun === true && parseConsolidateInput('dry hrm1').project === 'hrm1')
check('регистр имени проекта не важен', parseConsolidateInput('HRM1').project === 'hrm1', JSON.stringify(parseConsolidateInput('HRM1')))

console.log('\n== вкладка настроек ==')
{
  pointAt(workspace)
  const panel = makeContext({})
  const paths = panel.routes.map((route) => `${route.kind}:${route.path}`).join(' ')
  check('маршруты вкладки объявлены', panel.routes.length === 5, paths)
  check('состояние, запуск, отмена, список моделей и выбор модели — своими адресами', ['/engram-memory/state', '/engram-memory/run', '/engram-memory/cancel', '/engram-memory/models', '/engram-memory/model'].every((path) => paths.includes(path)), paths)
  check('маршруты точные, без префикса', panel.routes.every((route) => route.kind === 'exact'), paths)
  const ask = async (suffix, method) =>
    new Promise((resolve) => {
      const chunks = []
      const res = {
        writeHead: (code, headers) => chunks.push(String(code), String(headers?.['content-type'] ?? '')),
        end: (text) => {
          chunks.push(text)
          resolve(chunks.join('|'))
        }
      }
      panel.routes.find((route) => route.path.endsWith(suffix)).handler({ url: `/engram-memory${suffix}`, method }, res)
    })
  const state = await ask('/state', 'GET')
  check('состояние отдаётся как JSON', state.startsWith('200|application/json'), state.slice(0, 60))
  check('проекты вкладки приходят из базы', /"projects":\[\{"project":"demo"/.test(state), state.slice(-260))
  check('необработанные заметки посчитаны по базе', state.includes('"total":2') && state.includes('"unprocessed":2'), state.slice(-240))
  check('состояние MCP в ответе есть', state.includes('"declared"'), state.slice(-120))
  check('модель обработки взята из настроек, а не из сессии', state.includes('"provider":"test-provider"') && state.includes('"model":"test-model"'), state.slice(-300))
  check('цена нажатия посчитана до нажатия', state.includes('"estimate"') && state.includes('"perPassNotes":2'), state.slice(-260))
  check('предел проходов отдан интерфейсу', state.includes('"maxPasses":3'), state.slice(-160))
  check('проход описан состоянием', state.includes('"running":false'), state.slice(-160))
  const onRun = await ask('/run', 'GET')
  check('запуск по GET отвергается', onRun.startsWith('405'), onRun)
  const catalog = await ask('/models', 'GET')
  check('список моделей отдаётся, даже если служба моделей недоступна', catalog.startsWith('200|application/json') && catalog.includes('"models":[]'), catalog)
  const onModelGet = await ask('/model', 'GET')
  check('выбор модели по GET отвергается', onModelGet.startsWith('405'), onModelGet)
  const onModelEmpty = await ask('/model', 'POST')
  check('выбор модели без provider и model отвергается', onModelEmpty.startsWith('400') && onModelEmpty.includes('provider'), onModelEmpty)
}

console.log('\n== освобождение стора ==')
let disposeOk = true
for (const context of contexts) {
  try {
    context.dispose?.()
  } catch (error) {
    disposeOk = false
    console.log(`  FAIL dispose бросил: ${error}`)
  }
}
check('dispose закрывает базу без ошибок', disposeOk)
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    rmSync(root, { recursive: true, force: true })
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
assert.equal(failures, 0)
