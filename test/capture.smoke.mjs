// Проверка разбора хода: когда запись нужна, а когда нет.
//
// Проверяется чистая логика — та же, что работает в плагине: сообщения хода
// приходят готовыми, LLM не участвует, поведение детерминировано.
import { digestTurn, saveArgs, titleFrom, topicFrom } from '../lib/capture.js'

let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (blocks) => ({ role: 'assistant', source: { kind: 'model' }, content: blocks })
const call = (name, args) => ({ type: 'tool-call', id: 'call-1', name, arguments: JSON.stringify(args) })
const text = (value) => ({ type: 'text', text: value })

const LONG = 'Разобрал сохранение регионов в шаблоне: регион выбирается по времени регистрации, ' +
  'МИНИМУМ по дате, при равенстве дат берём регион последней записи. Поправил запрос: убрал ' +
  'неявное соединение, добавил проверку на пустой результат и тестовый пример на две записи ' +
  'с одной датой и разными регионами — поведение теперь совпадает с постановкой.'

console.log('== ход без работы не сохраняется ==')
check('пустая история', digestTurn([], {}) === null)
check('одна реплика пользователя', digestTurn([user('сделай что-нибудь')], {}) === null)
check(
  'только разговор, без изменений',
  digestTurn([user('вопрос'), assistant([text(LONG)])], { minSummary: 50 }) === null
)
check(
  'изменения есть, но итог короткий',
  digestTurn([user('правь'), assistant([call('edit', { file_path: 'Module.bsl' }), text('готово')])], {
    minSummary: 200
  }) === null
)

console.log('\n== ход с работой сохраняется ==')
const full = [
  user('ПереопределитьРегионПоВремениРегистрации: выбери регион по времени регистрации'),
  assistant([text('Смотрю текущий запрос и метаданные регистра.')]),
  assistant([call('edit', { file_path: 'ExternalFiles/АВТ_Шаблон/Ext/ObjectModule.bsl' }), text(LONG)]),
  user('а если даты равны?')
]
const record = digestTurn(full, { project: 'hrm1', type: 'discovery' })
check('запись построена', record !== null)
check('заголовок — первая строка итога', record?.title.startsWith('Разобрал сохранение регионов'), record?.title)
check('проект подставлен', record?.project === 'hrm1')
check('файл попал в запись', (record?.content ?? '').includes('ObjectModule.bsl'))
check('запрос пользователя попал в запись', (record?.content ?? '').includes('Запрос: ПереопределитьРегион'))
check('тема стабильна', record?.topic === topicFrom('hrm1', record?.title ?? ''), record?.topic)

const commandOnly = [
  user('прогони тесты'),
  assistant([call('pwsh', { command: 'node test/hook.smoke.mjs' }), text(LONG)]),
  user('что дальше?')
]
check('ход с командой тоже сохраняется', digestTurn(commandOnly, { project: 'hrm1' }) !== null)
check(
  'при requireChange: false хватает итога',
  digestTurn([user('объясни'), assistant([text(LONG)]), user('ясно')], { project: 'hrm1', requireChange: false }) !== null
)

console.log('\n== разбор хода целиком (turn/end) ==')
const whole = digestTurn(
  [
    user('доведи выбор региона'),
    assistant([call('edit', { file_path: 'ObjectModule.bsl' }), text(LONG)])
  ],
  { project: 'hrm1', turn: 'current' }
)
check('ход целиком разобран без завершающей реплики', whole !== null)
check('запрос найден внутри хода', (whole?.content ?? '').includes('Запрос: доведи выбор региона'))
check('тот же ход в режиме previous даёт запись', digestTurn(
  [
    user('доведи выбор региона'),
    assistant([call('edit', { file_path: 'ObjectModule.bsl' }), text(LONG)]),
    user('спасибо')
  ],
  { project: 'hrm1' }
) !== null)

console.log('\n== аргументы CLI ==')
const args = saveArgs(record)
check('подкоманда save', args[0] === 'save')
check('заголовок и текст на месте', args[1] === record.title && args[2] === record.content)
check('проект и уровень явные', args.includes('--project') && args.includes('hrm1') && args.includes('--scope') && args.includes('project'))
check('тема передана (engram обновит запись, а не создаст дубль)', args.includes('--topic') && args.includes(record.topic))
check('тип передан', args.includes('--type') && args.includes('discovery'))

console.log('\n== заголовок записи ==')
check(
  'приветствие не становится заголовком',
  titleFrom('Привет!\n\nГотовый ассет-пак машин лежит в Projects/old cars и ждёт публикации') ===
    'Готовый ассет-пак машин лежит в Projects/old cars и ждёт публикации',
  titleFrom('Привет!\n\nГотовый ассет-пак машин лежит в Projects/old cars и ждёт публикации')
)
check(
  'короткая строка пропускается',
  titleFrom('Ок\n\nСобрал релизный архив и проверил контрольные суммы') === 'Собрал релизный архив и проверил контрольные суммы'
)
check('markdown-акценты вычищены', !titleFrom('**Готовый пак** для `Unity` из 17 спрайтов').includes('*'), titleFrom('**Готовый пак** для `Unity` из 17 спрайтов'))
check('из одних приветствий берём первую строку', titleFrom('Привет!\nОк') === 'Привет!')
check('тема не кончается дефисом', !topicFrom('pix', 'я'.repeat(200)).endsWith('-'), topicFrom('pix', 'я'.repeat(200)))

console.log('\n== усечение ==')
const long = digestTurn(
  [user('длинная работа'), assistant([call('write', { file_path: 'a.bsl' }), text('х'.repeat(5000))])],
  { project: 'hrm1', maxChars: 300 }
)
check('тело обрезано по бюджету', (long?.content ?? '').length <= 300, String((long?.content ?? '').length))
check('заголовок укорочен', titleFrom('я'.repeat(400), 120).length <= 120)

console.log(failed === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
