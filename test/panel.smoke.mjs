// Проверки половины плагина для вкладки: статистика по заметкам, состояние
// прохода и ответы маршрутов. Десктоп не нужен: маршруты вызываются с поддельным
// запросом, состояние прохода — с поддельным проходом.
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createStore, openReadOnly } from './_engram-fixture.mjs'
import { createJob, panelStatistics, parseSourceIds, sendJson, stateHandler } from '../lib/panel.js'

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

console.log('== ссылки на источники ==')
check('ссылки читаются из строки «Источники:»', [...parseSourceIds('вывод\n\nИсточники: #1, #2')].join(',') === '1,2')
check('без строки источников — пусто', parseSourceIds('просто текст').size === 0)
check('в источники попадают только числа', [...parseSourceIds('Источники: #1, мусор #7')].join(',') === '1,7')

const fixture = createStore(
  [
    { title: 'Сырая заметка один', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
    { title: 'Сырая заметка два', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
    { title: 'Сырая заметка три', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
    { title: 'Карточка-вывод', content: `${longText('вывод')}\n\nИсточники: #1, #2`, project: 'demo', type: 'pattern' },
    { title: 'Помеченная заметка', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
    { title: 'Удалённая заметка', content: longText('разбор хода'), project: 'demo', type: 'discovery' },
    { title: 'Заметка другого проекта', content: longText('разбор хода'), project: 'other', type: 'discovery' }
  ],
  { dir: undefined }
)
const writable = new DatabaseSync(fixture.path)
writable.prepare('UPDATE observations SET pinned = 1 WHERE id = 5').run()
writable.prepare("UPDATE observations SET deleted_at = '2026-09-24 00:00:00' WHERE id = 6").run()
writable.close()
const store = openReadOnly(fixture.path)

console.log('\n== статистика ==')
const stats = panelStatistics(store, 'demo')
check('сырые заметки считаются без выводов, помеченных и удалённых', stats.total === 3, JSON.stringify(stats))
check('сведёнными считаются только те, на которые ссылается карточка', stats.processed === 2 && stats.unprocessed === 1, JSON.stringify(stats))
check('карточки считаются отдельно', stats.cards === 1, String(stats.cards))
check('полоска — доля сведённых', Math.abs(stats.bar - 2 / 3) < 0.001, String(stats.bar))
check('чужой проект не подмешивается', panelStatistics(store, 'other').total === 1)
check('неизвестный проект — нули', panelStatistics(store, 'нет-такого').total === 0)
check('без проекта — нули, без падения', panelStatistics(store, null).total === 0)

console.log('\n== состояние прохода ==')
{
  const job = createJob(async () => ({ status: 'ok', notes: 7, cards: 2, saved: [{ title: 'Вывод', sources: [1] }], usage: { totalTokens: 900 }, report: 'Обработано 7 заметок → 2 карточки.' }))
  check('до запуска проход не идёт', job.status().running === false && job.status().report === null)
  const started = await job.start()
  check('запуск отдаёт состояние прохода', started.started === true && started.status.ok === true, JSON.stringify(started.status))
  check('отчёт и числа сохранены', job.status().report === 'Обработано 7 заметок → 2 карточки.' && job.status().notes === 7 && job.status().cards === 2)
  check('токены и модели в состоянии есть', job.status().tokens === 900)
  check('после завершения проход не идёт', job.status().running === false && typeof job.status().finishedAt === 'string')
}
{
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const slow = createJob(async () => {
    await gate
    return { status: 'ok', report: 'поздно' }
  })
  const first = slow.start()
  const second = await slow.start()
  check('второй запуск во время прохода отклоняется', second.started === false && /идёт/.test(second.reason), JSON.stringify(second))
  release()
  await first
  check('проход завершился после сигнала', slow.status().running === false && slow.status().report === 'поздно', JSON.stringify(slow.status()))
}
{
  const job = createJob(async () => {
    throw new Error('провайдер недоступен')
  }, { log: () => {} })
  await job.start()
  check('ошибка прохода попадает в состояние', job.status().ok === false && job.status().error === 'провайдер недоступен', JSON.stringify(job.status()))
}
{
  const job = createJob(
    (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('обработка отменена')))
      }),
    { log: () => {} }
  )
  const pending = job.start()
  const cancelled = job.cancel()
  check('отмена принята', cancelled.cancelled === true)
  await pending
  check('отменённый проход не остаётся идущим', job.status().running === false && /отменена/.test(String(job.status().error)), JSON.stringify(job.status()))
  check('повторная отмена — тихий отказ', job.cancel().cancelled === false)
}

console.log('\n== маршруты ==')
{
  const ok = await new Promise((resolve) => {
    const chunks = []
    const res = {
      writeHead: (code, headers) => chunks.push(String(code), String(headers['content-type'])),
      end: (text) => {
        chunks.push(text)
        resolve(chunks.join('|'))
      }
    }
    stateHandler(async () => ({ project: 'demo', notes: { total: 3, unprocessed: 1 }, mcp: { declared: true }, job: { running: false } }))(
      { url: '/engram-memory/state', method: 'GET' },
      res
    )
  })
  check('состояние отдаётся как JSON', ok.startsWith('200|application/json'), ok.slice(0, 60))
  check('в ответе есть проект и заметки', ok.includes('"project":"demo"') && ok.includes('"unprocessed":1'), ok.slice(-80))
}
{
  const failed = await new Promise((resolve) => {
    const chunks = []
    const res = {
      writeHead: (code) => chunks.push(String(code)),
      end: (text) => {
        chunks.push(text)
        resolve(chunks.join('|'))
      }
    }
    stateHandler(async () => {
      throw new Error('база закрыта')
    })({ url: '/engram-memory/state', method: 'GET' }, res)
  })
  check('ошибка состояния не молчит', failed.startsWith('500') && failed.includes('база закрыта'), failed)
}
{
  const captured = await new Promise((resolve) => {
    const res = {
      writeHead: (code) => resolve({ code }),
      end: () => {}
    }
    sendJson(res, 409, { ok: true, started: false, reason: 'уже идёт обработка' })
  })
  check('отказ отправляется своим кодом', captured.code === 409)
}

store.close?.()
rmSync(fixture.dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
