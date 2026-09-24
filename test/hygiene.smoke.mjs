// Проверки гигиены: что в базе усвоено выводами, что ждёт свода, что дублируется
// и что можно убрать из обращения. Ничего не пишется: уборку проверяем на
// аргументах, которые получил бы CLI.
import { rmSync } from 'node:fs'
import { createStore, openReadOnly } from './_engram-fixture.mjs'
import { cardsBySource, compactableNotes, hygieneReport, relations, removeArgs } from '../lib/hygiene.js'

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
  { title: 'Заметка усвоенная', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Заметка в очереди', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Карточка-вывод', content: `${longText('вывод')}\n\nИсточники: #1`, project: 'demo', type: 'pattern' },
  { title: 'Заметка общего слоя', content: longText('разбор хода'), project: 'demo', scope: 'personal', type: 'discovery' },
  { title: 'Заметка помеченная', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Заметка удалённая', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Заметка старая усвоенная', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Карточка вторая', content: `${longText('вывод')}\n\nИсточники: #7`, project: 'demo', type: 'pattern' }
])

console.log('== отчёт по базе ==')
{
  const { DatabaseSync } = await import('node:sqlite')
  const writable = new DatabaseSync(fixture.path)
  writable.prepare('UPDATE observations SET pinned = 1 WHERE id = 5').run()
  writable.prepare("UPDATE observations SET deleted_at = '2026-09-24 00:00:00' WHERE id = 6").run()
  writable.prepare('UPDATE observations SET duplicate_count = 2 WHERE id = 2').run()
  writable.prepare("UPDATE observations SET updated_at = '2020-01-01 00:00:00' WHERE id = 7").run()
  writable.close()
}

const store = openReadOnly(fixture.path)
const report = hygieneReport(store, { days: 30 })
check('всего записей посчитано', report.total === 8, String(report.total))
check('удалённое считается отдельно', report.removed === 1, String(report.removed))
check('заметки в обращении — без помеченных вручную', report.raw === 4, String(report.raw))
check('усвоенное видно по ссылкам из выводов', report.consumed === 2, String(report.consumed))
check('очередь — то, на что выводов ещё нет', report.queued === 1, String(report.queued))
check('самая старая заметка в очереди названа', report.oldestQueuedAt !== null, String(report.oldestQueuedAt))
check('помеченные вручную не смешиваются с очередью', report.pinned === 1, String(report.pinned))
check('общий слой не смешивается с очередью', report.shared === 1, String(report.shared))
check('дубли считает сама база', report.duplicates === 1, String(report.duplicates))
check('связей нет, если таблицы связей нет', report.relations.total === 0 && report.relations.pending === 0)

console.log('\n== уборка: только усвоенное и только старое ==')
const stale = compactableNotes(store, { days: 30 })
check('на уборку попадает ровно старая усвоенная заметка', stale.length === 1 && stale[0].id === 7, JSON.stringify(stale))
check('и к ней приложен вывод, который её усвоил', stale[0].card === 8, String(stale[0].card))
check('отчёт и уборка согласованы', report.compactable === stale.length, `${report.compactable} против ${stale.length}`)
check('свежая усвоенная заметка не забирается', stale.every((note) => note.id !== 1))
check('аргументы уборки — мягкое удаление', removeArgs(7).join(' ') === 'delete 7', removeArgs(7).join(' '))
check('жёсткого удаления в аргументах не бывает', removeArgs(7).includes('--hard') === false)
check('порог по дням настраивается', compactableNotes(store, { days: 5000 }).length === 0)

console.log('\n== случай нулевого дня и пустого порога ==')
const zeroDays = compactableNotes(store, { days: 0 })
check('при нуле дней забирается всё усвоенное в проекте', zeroDays.length === 2 && zeroDays.every((note) => [1, 7].includes(note.id)), JSON.stringify(zeroDays.map((note) => note.id)))

console.log('\n== соседи не задеты ==')
const sources = cardsBySource(store)
check('ссылки прочитаны из обеих карточек', sources.get(1)[0] === 3 && sources.get(7)[0] === 8, JSON.stringify([...sources]))
check('заметок без выводов в ссылках нет', sources.has(2) === false)
check('без базы отчёт нулевой и не падает', hygieneReport(null).total === 0 && hygieneReport(null).compactable === 0)
check('без базы ссылок нет', cardsBySource(null).size === 0)
check('без базы связей нет', relations(null).total === 0 && relations(null).supersedes === 0)

console.log('\n== помеченное и общее не убираются никогда ==')
const guarded = createStore([
  { title: 'Старая усвоенная', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
  { title: 'Карточка', content: `вывод\n\nИсточники: #1`, project: 'demo', type: 'pattern' },
  { title: 'Старая усвоенная в общем слое', content: longText('разбор хода'), project: 'demo', scope: 'global', type: 'discovery' },
  { title: 'Карточка вторая', content: `вывод\n\nИсточники: #3`, project: 'demo', type: 'pattern' }
])
{
  const { DatabaseSync } = await import('node:sqlite')
  const writable = new DatabaseSync(guarded.path)
  writable.prepare("UPDATE observations SET updated_at = '2020-01-01 00:00:00'").run()
  writable.prepare('UPDATE observations SET pinned = 1 WHERE id = 1').run()
  writable.close()
}
const guardedStore = openReadOnly(guarded.path)
check('помеченная заметка уборке не подлежит', compactableNotes(guardedStore, { days: 30 }).length === 0)
check('и отчёт об этом честно говорит', hygieneReport(guardedStore, { days: 30 }).compactable === 0)

console.log('\n== связи, когда база их знает ==')
{
  const { DatabaseSync } = await import('node:sqlite')
  const writable = new DatabaseSync(fixture.path)
  writable.exec('CREATE TABLE memory_relations (id INTEGER PRIMARY KEY, relation TEXT, judgment_status TEXT)')
  const insert = writable.prepare('INSERT INTO memory_relations (relation, judgment_status) VALUES (?, ?)')
  insert.run('supersedes', 'judged')
  insert.run('related', 'judged')
  insert.run('pending', 'pending')
  insert.run('contradicts', 'judged')
  writable.close()
}
const withRelations = openReadOnly(fixture.path)
{
  const found = relations(withRelations)
  check('связи считаются по видам', found.total === 4 && found.supersedes === 1 && found.related === 1 && found.contradicts === 1, JSON.stringify(found))
  check('неразобранные связи видны отдельно', found.pending === 1, JSON.stringify(found))
  check('и отчёт берёт связи из базы', hygieneReport(withRelations).relations.total === 4)
}

store.close()
guardedStore.close()
withRelations.close()
rmSync(fixture.dir, { recursive: true, force: true })
rmSync(guarded.dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
