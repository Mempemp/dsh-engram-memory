// Проверка хост-половины: плагин поднимает pre-step, инжектит в бюджет,
// не повторяет одну запись в рамках сессии и молча пропускает ход, когда
// памяти нет или включить нечего.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, captureEnv, inject, projectOf } from '../lib/index.js'
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

function makeContext(config) {
  const listeners = new Map()
  const warnings = []
  const sections = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return { dispose: () => {} }
      }
    },
    on: (event, handler) => {
      const registered = listeners.get(event)
      if (registered === undefined) listeners.set(event, [handler])
      else registered.push(handler)
    }
  }
  apply(ctx, config)
  const context = {
    preStep: listeners.get('agent/pre-step')?.[0],
    fire: (event, ...args) => (listeners.get(event) ?? []).forEach((handler) => handler(...args)),
    dispose: listeners.get('dispose')?.[0],
    sections,
    warnings
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
check('это сообщение плагина', injected.messages[0].source?.plugin === 'dsh-engram-bridge', JSON.stringify(injected.messages[0].source))
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
const guided = makeContext({})
const guidance = guided.sections.find((spec) => typeof spec.text === 'string' && spec.text.includes('Память проекта (engram)'))
check('секция промпта зарегистрирована', guidance !== undefined)
check('в правилах есть уровни памяти', (guidance?.text ?? '').includes('`global`'), (guidance?.text ?? '').slice(0, 80))
check('секция не подменяет промпт целиком', guidance?.complete !== true)

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
