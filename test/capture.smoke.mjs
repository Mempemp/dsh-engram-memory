// Проверка разбора хода: когда запись нужна, а когда нет.
//
// Проверяется чистая логика — та же, что работает в плагине: сообщения хода
// приходят готовыми, LLM не участвует, поведение детерминировано.
import { digestTurn, narrowNote, saveArgs, titleFrom, topicFrom } from '../lib/capture.js'

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
/**
 * Проза из записи: от «Итог:» до ближайшего списка. Сплитом по пустой строке её
 * не достать — абзацы прозы сами разделены пустыми строками.
 */
const proseOf = (record) => {
  const content = record?.content ?? ''
  const start = content.indexOf('Итог: ')
  if (start < 0) return ''
  const rest = content.slice(start + 'Итог: '.length)
  const stop = rest.search(/\n\n(?:Файлы|Команды|Прочитано): /u)
  return stop < 0 ? rest : rest.slice(0, stop)
}

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
  'без изменений и без чтения записи нет',
  digestTurn([user('объясни'), assistant([text(LONG)]), user('ясно')], { project: 'hrm1' }) === null
)

console.log('\n== исследовательский ход тоже запоминается ==')
const researchTurn = (count) => [
  user('посмотри, как устроен пак'),
  assistant([
    ...Array.from({ length: count }, (_, index) => call('read', { file_path: `Projects/old cars/file${index}.json` })),
    text(LONG)
  ]),
  user('ясно')
]
const studied = digestTurn(researchTurn(3), { project: 'pixerartist' })
check('три чтения и содержательный итог — запись есть', studied !== null)
check(
  'в записи видно, что читали',
  (studied?.content ?? '').includes('Прочитано:') && (studied?.content ?? '').includes('file0.json'),
  (studied?.content ?? '').slice(0, 120)
)
check('изменённых файлов не приписано', !(studied?.content ?? '').includes('Файлы:'))
check('двух чтений мало', digestTurn(researchTurn(2), { project: 'pixerartist' }) === null)
check(
  'requireChange: true оставляет только правки',
  digestTurn(researchTurn(3), { project: 'pixerartist', requireChange: true }) === null
)
check('research: false выключает разбор', digestTurn(researchTurn(3), { project: 'pixerartist', research: false }) === null)

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
check('короткая строка с числом годится', titleFrom('Фикс 413') === 'Фикс 413', titleFrom('Фикс 413'))
check('короткая строка с двоеточием годится', titleFrom('Диаризация: выбор') === 'Диаризация: выбор', titleFrom('Диаризация: выбор'))
check(
  'междометие пропускается, берём следующую строку',
  titleFrom('Ок\n\nРазобрал выбор региона и поправил запрос') === 'Разобрал выбор региона и поправил запрос'
)
check(
  'приветствие в начале содержательной строки снимается',
  titleFrom('Привет! Это готовый ассет-пак машин') === 'Это готовый ассет-пак машин',
  titleFrom('Привет! Это готовый ассет-пак машин')
)
check('из одних междометий берём первую строку', titleFrom('Привет!\nОк') === 'Привет!')
check('тема не кончается дефисом', !topicFrom('pix', 'я'.repeat(200)).endsWith('-'), topicFrom('pix', 'я'.repeat(200)))

console.log('\n== усечение ==')
const long = digestTurn(
  [user('длинная работа'), assistant([call('write', { file_path: 'a.bsl' }), text('х'.repeat(5000))])],
  { project: 'hrm1', maxChars: 300 }
)
check('тело обрезано по бюджету', (long?.content ?? '').length <= 300, String((long?.content ?? '').length))
check('заголовок укорочен', titleFrom('я'.repeat(400), 120).length <= 120)

console.log('\n== бюджет списков: режется проза, а не пути ==')
const manyFiles = Array.from({ length: 6 }, (_, index) => `D:/proj/lib/файл-${index + 1}.js`)
const heavy = digestTurn(
  [
    user('перепиши все модули и прогони тесты'),
    assistant([
      ...manyFiles.map((file, index) => call('patch', { file_path: file, id: index })),
      call('terminal', { command: 'node test/store.smoke.mjs' }),
      call('terminal', { command: 'node test/hook.smoke.mjs' }),
      text('ы'.repeat(8000))
    ])
  ],
  { project: 'hrm1', turn: 'current' }
)
check('длинный итог не выбивает файлы из записи', (heavy?.content ?? '').includes('Файлы: D:/proj/lib/файл-1.js'), heavy?.content.slice(-160))
check('команды тоже остаются', (heavy?.content ?? '').includes('Команды: node test/store.smoke.mjs'), heavy?.content.slice(-160))
check('тело по-прежнему в бюджете', (heavy?.content ?? '').length <= 2000, String((heavy?.content ?? '').length))
check('итог укорочен, а не выброшен', /Итог: ы+…/.test(heavy?.content ?? ''), (heavy?.content ?? '').slice(0, 120))
const bordered = digestTurn(
  [user('работа'), assistant([call('write', { file_path: 'a.bsl' }), text(`${'разбор хода. '.repeat(40)}\n\n${'хвост '.repeat(200)}`)])],
  { project: 'hrm1', turn: 'current', maxChars: 400 }
)
const prose = (bordered?.content ?? '').split('\n\n').find((part) => part.startsWith('Итог: ')) ?? ''
const blunt = digestTurn(
  [user('работа'), assistant([call('write', { file_path: 'a.bsl' }), text('я'.repeat(2000))])],
  { project: 'hrm1', turn: 'current', maxChars: 400 }
)
const bluntProse = (blunt?.content ?? '').split('\n\n').find((part) => part.startsWith('Итог: ')) ?? ''
check('обрезка итога встаёт на конец фразы, а не на символ', prose.endsWith('…') && /разбор хода…$/u.test(prose) && /[^\s]…$/u.test(prose), prose.slice(-40))
check('а без границы режется жёстко, без выдумок', bluntProse.endsWith('…') && bluntProse.slice(-2, -1) === 'я', bluntProse.slice(-20))
const tinyList = digestTurn(
  [user('правь'), assistant([...manyFiles.map((file) => call('edit', { file_path: file })), text('ы'.repeat(3000))])],
  { project: 'hrm1', turn: 'current', listMaxChars: 60 }
)
check('списки держатся своего бюджета', tinyList !== null && tinyList.content.length - tinyList.content.indexOf('Файлы: ') <= 70, String(tinyList?.content.length))
check('хотя бы один путь остаётся всегда', (tinyList?.content ?? '').includes('Файлы: D:/proj/lib/файл-1.js'), tinyList?.content.slice(-90))
check(
  'длинный путь режется, но не исчезает',
  (digestTurn([user('правь'), assistant([call('edit', { file_path: `D:/${'г'.repeat(300)}.js` }), text('ы'.repeat(2000))])], { project: 'hrm1', turn: 'current', listMaxChars: 80 })?.content ?? '').includes('Файлы: D:/ггг')
)
const shortSummary = digestTurn(
  [user('правь'), assistant([call('write', { file_path: 'a.bsl' }), text(LONG)])],
  { project: 'hrm1', turn: 'current' }
)
check('короткий итог не режется вовсе', (shortSummary?.content ?? '').includes(LONG), shortSummary?.content)

console.log('\n== пределы динамические: режем по границе, а не по символу ==')
const sentence = 'Разобрал выбор региона по времени регистрации. Дальше длинный хвост прочих подробностей'
check(
  'заголовок — целое предложение, если оно влезает',
  titleFrom(sentence, 60) === 'Разобрал выбор региона по времени регистрации…',
  titleFrom(sentence, 60)
)
const wordCut = titleFrom('Очень длинная строка без знаков препинания и без точек совсем', 30)
check('без пунктуации заголовок рвётся по слову, а не по букве', 'Очень длинная строка без знаков препинания и без точек совсем'.startsWith(wordCut.replace('…', '')) && wordCut.endsWith('…'), wordCut)
const paragraphs = ['абзац-один про разбор хода и порядок работы целиком. '.padEnd(200, 'ещё '), 'абзац-два про то же самое и тоже целиком. '.padEnd(200, 'ещё '), 'абзац-три про третью часть работы. '.padEnd(200, 'ещё ')].join('\n\n')
const byParagraph = digestTurn(
  [user('работа'), assistant([call('write', { file_path: 'a.bsl' }), text(paragraphs)])],
  { project: 'hrm1', turn: 'current', maxChars: 537 }
)
const paragraphProse = proseOf(byParagraph)
check('начало и вывод сохранены, середина — нет', paragraphProse.includes('абзац-один') && paragraphProse.includes('абзац-три') && !paragraphProse.includes('абзац-два'), paragraphProse.slice(-80))
check('о пропущенной середине сказано прямо', /пропущено \d+ знаков/u.test(paragraphProse), paragraphProse.slice(0, 220))
const longFirst = digestTurn(
  [user('работа'), assistant([call('write', { file_path: 'a.bsl' }), text(`${'слово '.repeat(60)}\n\n${'второй абзац тут. '.repeat(20)}`)])],
  { project: 'hrm1', turn: 'current', maxChars: 537 }
)
check(
  'длинный первый абзац не оставляет запись пустой',
  proseOf(longFirst).length >= 300,
  String(proseOf(longFirst).length)
)
check(
  'длина записи плавает, предел не превышен',
  [heavy, byParagraph, longFirst].every((item) => (item?.content ?? '').length <= 2000)
)

console.log('\n== проход обобщения читает заметку срезом ==')
const longNote = [
  'Запрос: сведи длинную работу в вывод',
  '',
  'начало работы: разобрался в устройстве модуля. '.repeat(12).trim(),
  '',
  'середина работы: переписывал запрос, гонял тесты, сверял метаданные. '.repeat(40).trim(),
  '',
  'вывод: регион берётся по времени регистрации, а не по последней записи. '.repeat(6).trim(),
  '',
  'Файлы: ExternalFiles/АБВ/Ext/ObjectModule.bsl',
  '',
  'Команды: node test/hook.smoke.mjs'
].join('\n')
const narrow = narrowNote(longNote, 1400)
check('срез уложился в бюджет', narrow.length <= 1400, String(narrow.length))
check('заметка была длиннее среза', longNote.length > 1400, String(longNote.length))
check('запрос не пострадал', narrow.includes('Запрос: сведи длинную работу в вывод'), narrow.slice(0, 120))
check('ключи не пострадали', narrow.includes('Файлы: ExternalFiles/АБВ/Ext/ObjectModule.bsl') && narrow.includes('Команды: node test/hook.smoke.mjs'))
check('вывод на месте', narrow.includes('вывод: регион берётся по времени регистрации'), narrow.slice(-200))
check('середина помечена пропуском', /пропущено \d+ знаков/u.test(narrow), String(narrow.length))
const fatMiddle = [
  'Запрос: сведи длинную работу в вывод',
  '',
  'начало работы: разобрался в устройстве модуля. '.repeat(12).trim(),
  '',
  'середина работы: переписывал запрос, гонял тесты, сверял метаданные. '.repeat(80).trim(),
  '',
  'вывод: регион берётся по времени регистрации, а не по последней записи. '.repeat(6).trim(),
  '',
  'Файлы: ExternalFiles/АБВ/Ext/ObjectModule.bsl',
  '',
  'Команды: node test/hook.smoke.mjs'
].join('\n')
check('короткая заметка не трогается вовсе', narrowNote(LONG, 1400) === LONG.trim())
check('длина середины на срез не влияет', narrowNote(longNote, 1400).length === narrowNote(fatMiddle, 1400).length, `${narrowNote(longNote, 1400).length} против ${narrowNote(fatMiddle, 1400).length}`)
check('заметка вдвое длиннее читается тем же срезом', fatMiddle.length > longNote.length * 1.2 && narrowNote(fatMiddle, 1400).length === narrow.length)

console.log(failed === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
