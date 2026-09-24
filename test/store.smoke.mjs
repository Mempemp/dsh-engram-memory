// Проверка поиска по базе engram: запросы на русском, бюджет, промахи.
//
// Прогоняется на синтетической базе со схемой engram. Если рядом есть настоящий
// бинарник (ENGRAM_EXE или вендоренный в бандле), тот же набор проверяется на
// реальной базе, созданной через CLI: это ловит расхождения схемы.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { buildMatchQuery, formatInjection, openStore, searchObservations } from '../lib/engram-store.js'
import { createStore, openReadOnly } from './_engram-fixture.mjs'

const ENTRIES = [
  ['Каталог компонентов бандла', 'Каталог компонентов DSH-1C требует Node 24, иначе установка падает'],
  ['Диаризация в Минутмейстере', 'Диаризация в Минутмейстере сделана на pyannote, узкое место — WeSpeaker'],
  ['Пуш в GitHub', 'Пуш в GitHub только по явной команде пользователя'],
  ['Выгрузка объектов hrm1', 'В hrm1 выгрузка объектов идёт пообъектно, без ConfigDumpInfo.xml'],
  ['LiteLLM и NPU', 'LiteLLM роутит qwen35-moe на Lemonade через NPU, порт 13305'],
  ['Чанки для ASR', 'При 413 от ASR режем аудио на чанки не длиннее 900 секунд'],
  ['Запрет uv run в ai farm', 'uv run в ai farm сносит pip-пакеты, использовать только uv pip install'],
  ['Starlette 0.46', 'Starlette 0.46 требует TemplateResponse(request, name, ctx)'],
  ['Жизненный цикл MCP', 'Скиллы бандла должны владеть жизненным циклом MCP-сервера'],
  ['Сайдбар и React', 'Верстка сайдбара ломается, если перезаписать детей React-узла']
]

// Запросы: тип → [запрос, ожидаемый заголовок записи]
const QUERIES = [
  ['точная форма', 'диаризация pyannote', 'Диаризация в Минутмейстере'],
  ['точная форма', 'каталог компонентов', 'Каталог компонентов бандла'],
  ['точная форма', 'пуш в github', 'Пуш в GitHub'],
  ['падеж', 'узкое место диаризации', 'Диаризация в Минутмейстере'],
  ['падеж', 'как добавить компонент в каталог', 'Каталог компонентов бандла'],
  ['падеж', 'выгрузка объектов из hrm1', 'Выгрузка объектов hrm1'],
  ['словообразование', 'каталожные файлы компонентов', 'Каталог компонентов бандла'],
  ['словообразование', 'выгрузить объекты hrm1', 'Выгрузка объектов hrm1'],
  ['словообразование', 'разбиение аудио на чанки', 'Чанки для ASR'],
  ['множественное', 'компоненты каталога', 'Каталог компонентов бандла'],
  ['множественное', 'чанки аудио для asr', 'Чанки для ASR'],
  ['синоним', 'резка длинного аудио на куски', 'Чанки для ASR'],
  ['синоним', 'почему установка падает на node 22', 'Каталог компонентов бандла'],
  ['идентификатор', 'hrm1 configdumpinfo', 'Выгрузка объектов hrm1'],
  ['идентификатор', 'lemonade 13305 npu', 'LiteLLM и NPU'],
  ['идентификатор', 'starlette templateresponse', 'Starlette 0.46'],
  ['регистр', 'ДИАРИЗАЦИЯ PYANNOTE', 'Диаризация в Минутмейстере'],
  ['смешанный', 'litellm npu порт qwen35-moe', 'LiteLLM и NPU'],
  ['смешанный', 'uv pip install пакеты сносит', 'Запрет uv run в ai farm']
]

function rankOf(db, query, project, expected) {
  const rows = searchObservations(db, { query, project, limit: 5 })
  const at = rows.findIndex((row) => row.title === expected)
  return { rank: at < 0 ? 0 : at + 1, rows }
}

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('== сборка запроса ==')
check(
  'стоп-слова и короткие слова выброшены',
  buildMatchQuery('как мне найти каталог компонентов') ===
    '"найти"* OR "каталог"* OR "катал"* OR "компонентов"* OR "компонент"*',
  buildMatchQuery('как мне найти каталог компонентов')
)
check('пустой запрос → null', buildMatchQuery('как и в на') === null, String(buildMatchQuery('как и в на')))
check('длинные слова усечены', buildMatchQuery('диаризации').includes('"диаризац"*'), buildMatchQuery('диаризации'))

console.log('\n== синтетическая база engram ==')
const fixture = createStore(ENTRIES.map(([title, content]) => ({ title, content, project: 'demo' })))
const db = openReadOnly(fixture.path)

const byType = new Map()
let hit5 = 0
let hit1 = 0
const started = process.hrtime.bigint()
for (const [type, query, expected] of QUERIES) {
  const { rank } = rankOf(db, query, 'demo', expected)
  if (rank === 1) hit1 += 1
  if (rank > 0) hit5 += 1
  const bucket = byType.get(type) ?? [0, 0]
  bucket[1] += 1
  if (rank > 0) bucket[0] += 1
  byType.set(type, bucket)
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

console.log('\n== recall по типам запросов (within top-5) ==')
for (const [type, [hit, total]] of byType) console.log(`  ${type.padEnd(18)} ${hit}/${total}`)
console.log(`  всего              ${hit5}/${QUERIES.length} (@1: ${hit1}/${QUERIES.length}) за ${elapsedMs.toFixed(1)} мс`)

check('recall@5 не ниже 80%', hit5 / QUERIES.length >= 0.8, `${hit5}/${QUERIES.length}`)
check('recall@1 не ниже 60%', hit1 / QUERIES.length >= 0.6, `${hit1}/${QUERIES.length}`)
check('запрос обрабатывается быстрее 20 мс', elapsedMs / QUERIES.length < 20, `${(elapsedMs / QUERIES.length).toFixed(2)} мс`)

console.log('\n== бюджет и мусор ==')
const rows = searchObservations(db, { query: 'диаризация pyannote', project: 'demo', limit: 5 })
const injection = formatInjection(rows, { budget: 1200, topK: 2 })
check('инъекция не пустая', typeof injection === 'string' && injection.length > 0)
check('инъекция влезает в бюджет 1200', injection.length <= 1200, `${injection.length}`)
check('без совпадений инъекции нет', formatInjection(searchObservations(db, { query: 'завтрак космонавта', project: 'demo' }), { budget: 1200, topK: 2 }) === null)
check('тугой бюджет отбрасывает запись целиком, а не режет', formatInjection(rows, { budget: 40, topK: 2 }) === null, String(formatInjection(rows, { budget: 40, topK: 2 })))
check('чужой проект не подмешивается', searchObservations(db, { query: 'диаризация pyannote', project: 'other', limit: 5 }).length === 0)
check('мягко удалённые не возвращаются', (() => {
  const removed = createStore([{ title: 'Удалённое', content: 'диаризация pyannote', project: 'demo' }])
  const writer = new DatabaseSync(removed.path)
  writer.exec("UPDATE observations SET deleted_at = datetime('now')")
  writer.close()
  const store = openReadOnly(removed.path)
  const found = searchObservations(store, { query: 'диаризация pyannote', project: 'demo', limit: 5 })
  store.close()
  rmSync(removed.dir, { recursive: true, force: true })
  return found.length === 0
})())
db.close()

console.log('\n== настоящий engram, если бинарник доступен ==')
const exeCandidates = [
  process.env.ENGRAM_EXE,
  'D:/cursor projects/DSH-1C-deskop-bundle/vendor/engram-mcp/engram.exe'
].filter((path) => typeof path === 'string' && path !== '')
const exe = exeCandidates.find((path) => existsSync(path))
if (exe === undefined) {
  console.log('  skip: engram.exe не найден (задай ENGRAM_EXE, чтобы прогнать на настоящей базе)')
} else {
  const realDir = mkdtempSync(join(tmpdir(), 'engram-real-'))
  const env = { ...process.env, ENGRAM_DATA_DIR: realDir.replaceAll('\\', '/'), ENGRAM_NO_UPDATE_CHECK: '1' }
  for (const [title, content] of ENTRIES) {
    const saved = spawnSync(exe, ['save', title, content, '--type', 'discovery', '--project', 'demo'], { env, encoding: 'utf8' })
    assert.equal(saved.status, 0, `engram save ${title}: ${saved.stderr}`)
  }
  const realDb = openStore(join(realDir, 'engram.db'))
  assert.ok(realDb !== null, 'настоящая база не открылась')
  let realHit5 = 0
  let realHit1 = 0
  for (const [, query, expected] of QUERIES) {
    const { rank } = rankOf(realDb, query, 'demo', expected)
    if (rank === 1) realHit1 += 1
    if (rank > 0) realHit5 += 1
  }
  console.log(`  настоящая база: recall@5 ${realHit5}/${QUERIES.length}, recall@1 ${realHit1}/${QUERIES.length}`)
  check('на настоящей базе recall@5 не ниже 75%', realHit5 / QUERIES.length >= 0.75, `${realHit5}/${QUERIES.length}`)
  realDb.close()
  rmSync(realDir, { recursive: true, force: true })
}

console.log('\n== подсказка об обобщении ==')
const ripeRow = { id: 9, title: 'Диаризация: выбор движка', content: 'Итог: pyannote по умолчанию', scope: 'project', revision_count: 4 }
const ripeText = formatInjection([ripeRow], {})
check('часто обновляемая тема получает подсказку обобщить', (ripeText ?? '').includes('сохрани вывод одной записью'), ripeText)
check('подсказка ссылается на саму запись', (ripeText ?? '').includes('- [9]'), ripeText)
check('в подсказке назван topic_key', (ripeText ?? '').includes('topic_key'))
const quietText = formatInjection([{ ...ripeRow, revision_count: 1 }], {})
check('запись без истории подсказки не получает', !(quietText ?? '').includes('сохрани вывод'), quietText)
const earlyText = formatInjection([{ ...ripeRow, revision_count: 2 }], {})
check('двух обновлений для подсказки мало', !(earlyText ?? '').includes('сохрани вывод'))
check('порог настраивается', (formatInjection([{ ...ripeRow, revision_count: 2 }], { cueMinRevisions: 2 }) ?? '').includes('сохрани вывод'))
check('подсказку можно выключить', !(formatInjection([ripeRow], { cue: false }) ?? '').includes('сохрани вывод'))
const tightText = formatInjection([ripeRow], { budget: 120 })
check('подсказка не вылезает за бюджет', tightText === null || tightText.length <= 120, String(tightText?.length))

rmSync(fixture.dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
