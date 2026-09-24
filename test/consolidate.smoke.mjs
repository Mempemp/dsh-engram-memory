// Проверки обобщения: отбор сырых заметок, подсказка модели, разбор ответа и
// запись карточек. Модель и запись подменяются — проход проверяется без сети,
// без ключей и без настоящего engram.
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createStore, openReadOnly } from './_engram-fixture.mjs'
import { buildMessages, cardBody, cardSaveArgs, collectNotes, consolidate, parseCards, renderReport } from '../lib/consolidate.js'

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

store.close?.()
rmSync(fixture.dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
