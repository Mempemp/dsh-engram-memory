// Проверка хост-половины: плагин поднимает pre-step, инжектит в бюджет,
// не повторяет одну запись в рамках сессии и молча пропускает ход, когда
// памяти нет или включить нечего.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, projectOf } from '../lib/index.js'
import { createStore } from './_engram-fixture.mjs'

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
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    on: (event, handler) => {
      listeners.set(event, handler)
    }
  }
  apply(ctx, config)
  const context = { preStep: listeners.get('agent/pre-step'), dispose: listeners.get('dispose'), warnings }
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
