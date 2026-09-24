// Проверки обобщения: отбор сырых заметок, подсказка модели, разбор ответа и
// запись карточек. Модель и запись подменяются — проход проверяется без сети,
// без ключей и без настоящего engram.
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createStore, openReadOnly } from './_engram-fixture.mjs'
import {
  buildMessages,
  cardBody,
  cardSaveArgs,
  collectNotes,
  consolidate,
  consolidateAll,
  estimateRun,
  parseCards,
  planCard,
  renderReport,
  renderRunReport
} from '../lib/consolidate.js'
import { scopeStatistics } from '../lib/panel.js'

let failures = 0
const check = (title, ok, extra = '') => {
  if (ok) {
    console.log(`  ok ${title}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${title}${extra === '' ? '' : ` — ${extra}`}`)
}

const longText = (prefix) => `${prefix} ${'подробность '.repeat(12)}`

const fixture = createStore([
  { title: 'Свежая заметка', content: longText('разбор хода номер один'), project: 'demo', type: 'discovery' },
  { title: 'Помеченная заметка', content: longText('разбор хода номер два'), project: 'demo', type: 'discovery' },
  { title: 'Готовый вывод', content: longText('разбор хода номер три'), project: 'demo', type: 'pattern' },
  { title: 'Чужой проект', content: longText('разбор хода номер четыре'), project: 'other', type: 'discovery' },
  { title: 'Удалённая заметка', content: longText('разбор хода номер пять'), project: 'demo', type: 'discovery' },
  { title: 'Заметка позавчерашняя', content: longText('разбор хода номер шесть'), project: 'demo', type: 'discovery' },
  { title: 'Заметка вчерашняя', content: longText('разбор хода номер семь'), project: 'demo', type: 'discovery' }
])
const writable = new DatabaseSync(fixture.path)
writable.prepare("UPDATE observations SET updated_at = '2026-09-20 10:00:00'").run()
writable.prepare("UPDATE observations SET updated_at = '2026-09-24 10:00:00', topic_key = 'demo/tema' WHERE id = 1").run()
writable.prepare('UPDATE observations SET pinned = 1 WHERE id = 2').run()
writable.prepare("UPDATE observations SET updated_at = '2026-09-23 10:00:00' WHERE id = 6").run()
writable.prepare("UPDATE observations SET updated_at = '2026-09-22 10:00:00' WHERE id = 7").run()
writable.prepare("UPDATE observations SET deleted_at = '2026-09-24 00:00:00' WHERE id = 5").run()
writable.close()
const store = openReadOnly(fixture.path)

console.log('== отбор сырых заметок ==')
const notes = collectNotes(store, { project: 'demo' })
check('берём только сырые заметки проекта: без выводов, помеченных и удалённых', notes.length === 3, `получено ${notes.length}`)
check('свежие сверху', notes.map((note) => note.id).join(',') === '1,6,7', notes.map((note) => note.id).join(','))
check('тема заметки доезжает до подборки', notes[0].topic_key === 'demo/tema', String(notes[0].topic_key))
check('предел по числу заметок работает', collectNotes(store, { project: 'demo', limit: 2 }).length === 2)
check('предел по знакам оставляет хотя бы одну заметку', collectNotes(store, { project: 'demo', maxChars: 50 }).length === 1)
check('чужой проект не подмешивается', collectNotes(store, { project: 'other' }).length === 1)
check('неизвестный проект — пусто', collectNotes(store, { project: 'нет-такого' }).length === 0)
check('без проекта — пусто', collectNotes(store, { project: '' }).length === 0)

console.log('\n== подсказка модели ==')
const messages = buildMessages(notes)
check('роль system отделена', messages[0].role === 'system' && messages[1].role === 'user')
check('заметки идут с идентификаторами', messages[1].content.includes('#1 ') && messages[1].content.includes('#6 '))
check('тема заметки видна модели', messages[1].content.includes('тема=demo/tema'))
check('структура вывода заказана', messages[1].content.includes('**What**') && messages[1].content.includes('**Learned**'))
check('формат ответа показан примером', messages[1].content.includes('"sources":[12,15]'))
check('запрет на выдумку сформулирован', messages[1].content.includes('не выдумывай'))

console.log('\n== цена прохода не зависит от длины заметок ==')
const bloated = [
  {
    id: 41,
    type: 'discovery',
    project: 'demo',
    title: 'Длинная работа',
    content: [
      'Запрос: сведи работу в вывод',
      '',
      'начало: разобрался в устройстве. '.repeat(20).trim(),
      '',
      'середина: правил, гонял тесты, сверял. '.repeat(120).trim(),
      '',
      'вывод: регион берётся по времени регистрации. '.repeat(8).trim(),
      '',
      'Файлы: ExternalFiles/АБВ/Ext/ObjectModule.bsl',
      '',
      'Команды: node test/hook.smoke.mjs'
    ].join('\n')
  },
  {
    id: 42,
    type: 'discovery',
    project: 'demo',
    title: 'Короткая работа',
    content: `Запрос: посмотри пак\n\nвывод: пак собран из 17 спрайтов.\n\nФайлы: pack.json`
  }
]
const bloatedMessages = buildMessages(bloated)
const payload = bloatedMessages[1].content
// Границы заметок — по их собственным заголовкам: сплит по разделителю захватил бы
// и инструкцию, которую плагин ставит перед списком.
const starts = [...payload.matchAll(/^#\d+ \[/gm)].map((match) => match.index)
const noteSizes = starts.map((from, index) => (index + 1 < starts.length ? starts[index + 1] : payload.length) - from)
check('список заметок собран из всех заметок', starts.length === 2, String(starts.length))
check('каждая заметка в проходе ограничена срезом', noteSizes.every((size) => size <= 1400 + 120), noteSizes.join(', '))
check('длинная заметка несёт свой вывод', payload.includes('вывод: регион берётся по времени регистрации'))
check('и свои ключи целиком', payload.includes('Файлы: ExternalFiles/АБВ/Ext/ObjectModule.bsl'))
check('короткую заметку проход читает как есть', payload.includes('вывод: пак собран из 17 спрайтов.'))
check('о пропущенной середине модель предупреждена', /пропущено \d+ знаков/u.test(payload))
const oneBefore = buildMessages([bloated[0]])[1].content.length
const oneAfter = buildMessages([
  { ...bloated[0], content: bloated[0].content.replace('середина: правил, гонял тесты, сверял. '.repeat(120), 'середина: правил, гонял тесты, сверял. '.repeat(360)) }
])[1].content.length
check('втрое более длинная середина не удорожает проход', oneAfter === oneBefore, `${oneBefore} против ${oneAfter}`)
check(
  'срез отключается настройкой бюджета',
  buildMessages([bloated[0]], { noteChars: 20000 })[1].content.includes('середина: правил, гонял тесты, сверял. '.repeat(2).trim().slice(0, 40))
)

console.log('\n== разбор ответа модели ==')
const good = JSON.stringify([
  { title: 'Диаризация: выбор движка', topic_key: 'Demo/Tema!', scope: 'global', sources: [1, 6, 6], content: longText('вывод по диаризации') },
  { title: 'Слишком короткий', sources: [1], content: 'мало' },
  { title: '', sources: [1], content: longText('без заголовка') }
])
const cards = parseCards('```json\n' + good + '\n```')
check('обёртка снимается, годные карточки проходят', cards.length === 1, `получено ${cards.length}`)
check('слаг темы приводится к латинице', cards[0].topicKey === 'demo/tema', cards[0].topicKey)
check('незнакомый scope падает в project', parseCards('[{"title":"Т","content":"' + longText('текст') + '","scope":"weird"}]')[0].scope === 'project')
check('источники берутся числами и только положительные', parseCards('[{"title":"Т","content":"' + longText('текст') + '","sources":[1,"2",0,-3,"x"]}]')[0].sources.join(',') === '1,2')
check('не JSON — пусто', parseCards('модель решила поговорить').length === 0)
check('пустой ответ — пусто', parseCards('').length === 0)

console.log('\n== тело карточки и аргументы записи ==')
const body = cardBody({ content: longText('вывод'), sources: [1, 6] })
check('ссылки на сырые заметки добавляет плагин, а не модель', body.endsWith('Источники: #1, #6'), body.slice(-40))
check('без источников строки нет', !cardBody({ content: longText('вывод'), sources: [] }).includes('Источники'))
const clipped = cardBody({ content: 'я'.repeat(5000), sources: [] }, { maxChars: 2000 })
check('тело не длиннее предела', clipped.length === 2000 && clipped.endsWith('…'), String(clipped.length))
const args = cardSaveArgs({ title: 'Вывод', content: 'тело', sources: [1], scope: 'global', topicKey: 'demo/tema', kind: 'decision' }, 'demo')
check('запись идёт командой save', args[0] === 'save' && args[1] === 'Вывод')
check('проект, слой, тип и тема переданы', ['--project', 'demo', '--scope', 'global', '--type', 'decision', '--topic', 'demo/tema'].every((part) => args.includes(part)), args.join(' '))
check('без темы флаг не передаётся', !cardSaveArgs({ title: 'Т', content: 'т', sources: [], scope: 'project', topicKey: '', kind: 'pattern' }, 'demo').includes('--topic'))

console.log('\n== проход целиком ==')
const answer = { text: JSON.stringify([{ title: 'Вывод по теме', topic_key: 'demo/tema', scope: 'project', sources: [1, 6, 999], content: longText('общий вывод') }]), model: 'test-model', usage: { totalTokens: 1234 } }
const calls = []
const fakeSave = async (savedArgs) => {
  calls.push(savedArgs)
}
const base = { store, project: 'demo', complete: async () => answer, save: fakeSave, notes }

const written = await consolidate(base)
check('карточка записана', written.saved.length === 1 && calls.length === 1)
check('запись ушла с темой и типом', calls[0].includes('--topic') && calls[0].includes('pattern'), calls[0].join(' '))
check('ссылка на несуществующую заметку отброшена', written.cards[0].sources.join(',') === '1,6', written.cards[0].sources.join(','))
check('в теле карточки стоят источники', calls[0][2].includes('Источники: #1, #6'), calls[0][2].slice(-40))
check('расход токенов в отчёте есть', written.usage.totalTokens === 1234)
check('отчёт говорит, что заметки целы', renderReport(written).includes('Сырые заметки остались на месте'))
check('отчёт показывает источники', renderReport(written).includes('← #1, #6'), renderReport(written))

calls.length = 0
const draft = await consolidate({ ...base, dryRun: true })
check('черновик ничего не записывает', draft.saved.length === 0 && calls.length === 0 && draft.cards.length === 1)
check('отчёт о черновике честный', renderReport({ ...draft, dryRun: true }).includes('ничего не записано'))

calls.length = 0
const failed = await consolidate({ ...base, complete: async () => { throw new Error('провайдер недоступен') } })
check('ошибка модели не пишет ничего', failed.status === 'model-failed' && calls.length === 0)
check('отчёт об ошибке называет причину', renderReport(failed).includes('провайдер недоступен'))

const noCards = await consolidate({ ...base, complete: async () => ({ text: 'ничего не нашёл' }) })
check('пустой разбор не пишет ничего', noCards.status === 'no-cards' && calls.length === 0)

calls.length = 0
const nowhere = await consolidate({ ...base, notes: [], store: null })
check('без заметок обобщать нечего', nowhere.status === 'empty' && renderReport(nowhere).includes('Обобщать нечего'))

const brokenSave = await consolidate({ ...base, save: async () => { throw new Error('engram занят') } })
check('отказ записи не роняет проход', brokenSave.status === 'ok' && brokenSave.saved.length === 0 && brokenSave.cards.length === 1)

console.log('\n== уже сведённое в порцию не попадает ==')
{
  // Карточка в том виде, в каком её пишет engram: тело вывода плюс строка источников.
  const patch = new DatabaseSync(fixture.path)
  patch
    .prepare(
      'INSERT INTO observations (title, content, project, scope, type, revision_count, created_at, updated_at, pinned) ' +
        "VALUES (?, ?, 'demo', 'project', 'pattern', 1, datetime('now'), datetime('now'), 0)"
    )
    .run('Вывод по демо', `${longText('вывод')}\n\nИсточники: #6`)
  patch.close()
  const left = collectNotes(store, { project: 'demo' })
  check('заметка, на которую ссылается карточка, в порцию не попадает', left.map((note) => note.id).join(',') === '1,7', left.map((note) => note.id).join(','))
  check('skipProcessed: false возвращает всё, как раньше', collectNotes(store, { project: 'demo', skipProcessed: false }).length === 3)
  check('в заметке порции виден её проект', left[0].project === 'demo', String(left[0].project))
}

console.log('\n== порция по всем проектам ==')
const multi = createStore([
  { title: 'Альфа 1', content: longText('разбор'), project: 'alpha', type: 'discovery' },
  { title: 'Альфа 2', content: longText('разбор'), project: 'alpha', type: 'discovery' },
  { title: 'Альфа 3', content: longText('разбор'), project: 'alpha', type: 'discovery' },
  { title: 'Бета 1', content: longText('разбор'), project: 'beta', type: 'discovery' },
  { title: 'Бета 2', content: longText('разбор'), project: 'beta', type: 'discovery' },
  { title: 'Гамма 1', content: longText('разбор'), project: 'gamma', type: 'discovery' }
])
const multiStore = openReadOnly(multi.path)
const ids = (notes) => notes.map((note) => `${note.id}:${note.project}`).join(' ')
// Свежесть у всех одна, поэтому внутри проекта порядок — по id сверху вниз.
check('порция идёт по кругу: в ней видны разные проекты', ids(collectNotes(multiStore)) === '3:alpha 5:beta 6:gamma 2:alpha 4:beta 1:alpha', ids(collectNotes(multiStore)))
check('предел порции держится', collectNotes(multiStore, { limit: 4 }).length === 4)
check('один проект берётся целиком', ids(collectNotes(multiStore, { projects: ['beta'] })) === '5:beta 4:beta', ids(collectNotes(multiStore, { projects: ['beta'] })))
check('список проектов ограничивает выборку', collectNotes(multiStore, { projects: ['gamma'] }).length === 1)
check('пустой список проектов — пусто', collectNotes(multiStore, { projects: [] }).length === 0)
check('без проекта и без списка берутся все проекты', collectNotes(multiStore, {}).length === 6)

console.log('\n== сырая заметка — всё, что не карточка ==')
const byType = createStore([
  { title: 'Хроника хода', content: longText('разбор'), project: 'mixed', type: 'discovery' },
  { title: 'Заметка своим типом', content: longText('разбор'), project: 'mixed', type: 'note' },
  { title: 'Находка модели', content: longText('разбор'), project: 'mixed', type: 'insight' },
  { title: 'Карточка вывода', content: `${longText('вывод')}\n\nИсточники: #1`, project: 'mixed', type: 'pattern' },
  { title: 'Решение', content: longText('вывод'), project: 'mixed', type: 'decision' },
  { title: 'Архитектура', content: longText('вывод'), project: 'mixed', type: 'architecture' }
])
const typeStore = openReadOnly(byType.path)
{
  const everything = collectNotes(typeStore, { projects: ['mixed'], skipProcessed: false })
  check('берётся заметка любого типа, а не только discovery', everything.map((note) => note.type).sort().join(',') === 'discovery,insight,note', everything.map((note) => note.type).join(','))
  check('карточки любого типа в порцию не попадают', !everything.some((note) => ['pattern', 'decision', 'architecture'].includes(note.type)), everything.map((note) => note.type).join(','))
  check('смена captureType больше ничего не ломает', collectNotes(typeStore, { projects: ['mixed'] }).length === 2, String(collectNotes(typeStore, { projects: ['mixed'] }).length))
  check('очередь совпадает с «несведёнными» на вкладке', scopeStatistics(typeStore).unprocessed === collectNotes(typeStore, {}).length, JSON.stringify({ unprocessed: scopeStatistics(typeStore).unprocessed, queue: collectNotes(typeStore, {}).length }))
}
typeStore.close?.()
rmSync(byType.dir, { recursive: true, force: true })

console.log('\n== цена нажатия до нажатия ==')
const estimate = estimateRun({ store: multiStore })
check('цена называет объём работы', estimate.planned === 6 && estimate.perPassNotes === 6, JSON.stringify(estimate))
check('шесть заметок — один проход', estimate.passes === 1 && estimate.capped === false, JSON.stringify(estimate))
check('токены считаются по знакам порции', estimate.tokens === estimate.perPassTokens && estimate.perPassTokens > 0, JSON.stringify(estimate))
check('разбивка по проектам в оценке есть', estimate.projects.map((bucket) => bucket.project).join(',') === 'alpha,beta,gamma')
const cappedEstimate = estimateRun({ store: multiStore, limit: 1, maxPasses: 3 })
check('предел проходов виден в цене', cappedEstimate.passes === 3 && cappedEstimate.capped === true, JSON.stringify(cappedEstimate))
check('пустая работа стоит нуля', estimateRun({ store: multiStore, projects: ['нет-такого'] }).tokens === 0)

console.log('\n== общий слой: только из источников двух проектов ==')
const mixed = [
  { id: 11, project: 'alpha' },
  { id: 12, project: 'beta' },
  { id: 13, project: 'alpha' }
]
check('global с источниками из двух проектов остаётся общим', planCard({ title: 'Т', scope: 'global', sources: [11, 12] }, mixed).scope === 'global')
{
  const plan = planCard({ title: 'Т', scope: 'global', sources: [11, 13] }, mixed)
  check('global из одного проекта понижается до проектного', plan.scope === 'project' && plan.project === 'alpha' && plan.downgraded === true, JSON.stringify(plan))
}
check('personal подчиняется тому же правилу', planCard({ title: 'Т', scope: 'personal', sources: [12] }, mixed).downgraded === true)
{
  const plan = planCard({ title: 'Т', scope: 'project', sources: [11, 12, 13] }, mixed)
  check('проектная карточка чистит чужие ссылки по большинству', plan.project === 'alpha' && plan.sources.join(',') === '11,13', JSON.stringify(plan))
}
check('карточка без источников уходит в проект порции', planCard({ title: 'Т', scope: 'project', sources: [] }, mixed, { fallback: 'beta' }).project === 'beta')
{
  const plan = planCard({ title: 'Т', scope: 'global', sources: [] }, mixed, { fallback: 'beta' })
  check('global без источников тоже понижается', plan.scope === 'project' && plan.project === 'beta', JSON.stringify(plan))
}

console.log('\n== карточка сама выбирает слой и адрес ==')
{
  const calls = []
  const save = async (args) => {
    calls.push(args)
  }
  const notes = [
    { id: 21, project: 'alpha', type: 'discovery', title: 'Альфа', content: longText('разбор') },
    { id: 22, project: 'beta', type: 'discovery', title: 'Бета', content: longText('разбор') }
  ]
  const answer = (cards) => ({ text: JSON.stringify(cards), model: 'test-model', usage: { totalTokens: 120, promptTokens: 100, completionTokens: 20 } })
  const shared = await consolidate({
    store: multiStore,
    notes,
    complete: async () => answer([{ title: 'Общая конвенция', topic_key: 'conv', scope: 'global', sources: [21, 22], content: longText('вывод') }]),
    save
  })
  check('карточка из двух проектов уходит в общий слой', shared.saved[0].scope === 'global' && calls[0].includes('global'), calls[0].join(' '))
  check('адрес общего вывода — проект его источников', calls[0][calls[0].indexOf('--project') + 1] === 'alpha', calls[0].join(' '))

  calls.length = 0
  const perProject = await consolidate({
    store: multiStore,
    notes,
    complete: async () =>
      answer([
        { title: 'Правило альфы', topic_key: 'a', scope: 'global', sources: [21], content: longText('вывод') },
        { title: 'Правило беты', topic_key: 'b', scope: 'project', sources: [22], content: longText('вывод') }
      ]),
    save
  })
  check('вывод одного проекта в общий слой не пускается', perProject.saved[0].scope === 'project' && perProject.saved[0].downgraded === true, JSON.stringify(perProject.saved[0]))
  check('каждая карточка пишется в свой проект', calls.map((args) => args[args.indexOf('--project') + 1]).join(',') === 'alpha,beta', calls.map((args) => args.join(' ')).join(' | '))
  check('отчёт говорит о понижении слоя', renderReport(perProject).includes('остались проектными'), renderReport(perProject))
}

console.log('\n== нажатие по всем проектам порциями ==')
const wrote = []
// Запись повторяет настоящий engram: строка ложится в базу, и следующий проход уже
// не видит помеченные ею заметки.
const writeCard = (args) => {
  const project = args[args.indexOf('--project') + 1]
  const scope = args[args.indexOf('--scope') + 1]
  const type = args[args.indexOf('--type') + 1]
  const db = new DatabaseSync(multi.path)
  db.prepare(
    'INSERT INTO observations (title, content, project, scope, type, revision_count, created_at, updated_at, pinned) ' +
      "VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), 0)"
  ).run(args[1], args[2], project, scope, type)
  db.close()
  wrote.push(`${project}:${scope}:${args[1]}`)
}
// Модель ссылается на все заметки порции: так видно и разбор ссылок, и адрес карточки.
const echo = async (messages) => {
  const ids = [...messages[1].content.matchAll(/#(\d+) /g)].map((match) => Number(match[1]))
  return {
    text: JSON.stringify([
      { title: `Вывод ${ids.join('-')}`, topic_key: `t${ids.join('-')}`, scope: 'project', sources: ids, content: longText('общий вывод по порции') }
    ]),
    model: 'test-model',
    usage: { totalTokens: 100, promptTokens: 80, completionTokens: 20 }
  }
}
{
  const progress = []
  const run = await consolidateAll({
    store: multiStore,
    complete: echo,
    save: writeCard,
    limit: 2,
    maxPasses: 3,
    onProgress: (state) => progress.push(state)
  })
  check('за нажатие сделано ровно столько проходов, сколько разрешено', run.passes === 3 && run.stopped === 'limit', JSON.stringify({ passes: run.passes, stopped: run.stopped }))
  check('остаток после остановки посчитан', run.left === 3 && run.processed === 3 && run.planned === 6, JSON.stringify({ left: run.left, processed: run.processed }))
  check('прогресс сообщался после каждого прохода', progress.length === 3 && progress[0].pass === 1 && progress[2].processed === 3, JSON.stringify(progress))
  check('расход токенов сложился по проходам', run.usage.totalTokens === 300 && run.usage.promptTokens === 240, JSON.stringify(run.usage))
  check('карточки легли в проекты своих источников', wrote.join(' ') === 'alpha:project:Вывод 3-5 alpha:project:Вывод 2-5 alpha:project:Вывод 1-5', wrote.join(' '))
  check('отчёт перечисляет проекты и остаток', renderRunReport(run).includes('Проекты: alpha — 3, beta — 2, gamma — 1') && renderRunReport(run).includes('нажмите ещё раз'), renderRunReport(run))
}
{
  const done = await consolidateAll({ store: multiStore, complete: echo, save: writeCard, limit: 2, maxPasses: 8 })
  check('проходы идут, пока есть несведённое', done.status === 'ok' && done.left === 0 && done.stopped === null, JSON.stringify({ status: done.status, left: done.left, stopped: done.stopped, passes: done.passes }))
  check('очередь после полного прохода пуста', scopeStatistics(multiStore).unprocessed === 0)
  check('отчёт о полном проходе называет числа', renderRunReport(done).includes('Сведено 3 из 3 заметок'), renderRunReport(done))
}
{
  const nothing = await consolidateAll({ store: multiStore, complete: echo, save: async () => {} })
  check('когда всё сведено, проход не начинается', nothing.status === 'empty' && nothing.passes === 0, JSON.stringify({ status: nothing.status, passes: nothing.passes }))
  check('пустая работа объяснена в отчёте', renderRunReport(nothing).includes('Обрабатывать нечего'), renderRunReport(nothing))
}

console.log('\n== предохранители: пустая порция, отмена, черновик ==')
const later = createStore([
  { title: 'Дельта 1', content: longText('разбор'), project: 'delta', type: 'discovery' },
  { title: 'Дельта 2', content: longText('разбор'), project: 'delta', type: 'discovery' },
  { title: 'Дельта 3', content: longText('разбор'), project: 'delta', type: 'discovery' },
  { title: 'Дельта 4', content: longText('разбор'), project: 'delta', type: 'discovery' }
])
const laterStore = openReadOnly(later.path)
{
  const silent = await consolidateAll({
    store: laterStore,
    complete: async () => ({ text: 'ничего не нашёл' }),
    save: async () => {
      throw new Error('при пустом ответе записи быть не должно')
    },
    limit: 2,
    maxPasses: 3
  })
  check('проход без карточек останавливает цикл', silent.status === 'no-cards' && silent.passes === 1 && silent.left === 4, JSON.stringify({ status: silent.status, passes: silent.passes, left: silent.left }))
  check('про остановку по кругу сказано прямо', renderRunReport(silent).includes('по кругу'), renderRunReport(silent))
}
{
  const controller = new AbortController()
  controller.abort(new Error('отмена'))
  const stopped = await consolidateAll({ store: laterStore, complete: echo, save: async () => {}, limit: 2, maxPasses: 3, signal: controller.signal })
  check('отмена до первого прохода модель не тратит', stopped.status === 'cancelled' && stopped.passes === 0, JSON.stringify({ status: stopped.status, passes: stopped.passes }))
}
{
  const between = new AbortController()
  const cancelledRun = await consolidateAll({
    store: laterStore,
    complete: echo,
    save: async () => {},
    limit: 2,
    maxPasses: 3,
    signal: between.signal,
    onProgress: (state) => {
      if (state.pass === 1) between.abort(new Error('хватит'))
    }
  })
  check('отмена между проходами останавливает цикл', cancelledRun.status === 'cancelled' && cancelledRun.passes === 1, JSON.stringify({ status: cancelledRun.status, passes: cancelledRun.passes }))
  check('отмена названа отменой в отчёте', renderRunReport(cancelledRun).includes('отменена'), renderRunReport(cancelledRun))
}
{
  const draft = await consolidateAll({
    store: laterStore,
    complete: echo,
    save: async () => {
      throw new Error('в черновике записи быть не должно')
    },
    dryRun: true,
    limit: 2,
    maxPasses: 3
  })
  check('черновик — один проход и ни одной записи', draft.passes === 1 && draft.saved.length === 0 && draft.cards.length === 1, JSON.stringify({ passes: draft.passes, saved: draft.saved.length }))
  check('о черновике сказано в отчёте', renderRunReport(draft).includes('ничего не записано'), renderRunReport(draft))
}
{
  const single = renderRunReport({ status: 'ok', plannedByProject: [{ project: 'demo', unprocessed: 3 }], passes: 1, notes: 3, cards: [], saved: [], dryRun: false })
  check('один проект за один проход — прежний отчёт', single.includes('Обобщено 3 заметок'), single)
}
laterStore.close?.()
rmSync(later.dir, { recursive: true, force: true })
multiStore.close?.()
rmSync(multi.dir, { recursive: true, force: true })

store.close?.()
rmSync(fixture.dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
