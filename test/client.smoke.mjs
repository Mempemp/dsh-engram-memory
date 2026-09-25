// Проверка клиентской половины без браузера: загрузчик DSH подделываем, хуки
// React — заглушками, а дерево разметки разбираем как данные. Так ловятся вещи,
// которых не видит ни один синтаксический контроль: подписи кнопок, числа в
// полоске, тексты ошибок и то, что кнопка действительно блокируется.
import { readFileSync } from 'node:fs'
let failures = 0
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const check = (title, ok, extra = '') => {
  if (ok) {
    console.log(`  ok ${title}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${title}${extra === '' ? '' : ` — ${extra}`}`)
}

// ── стенд: загрузчик модулей DSH ─────────────────────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      loaded = spec
    }
  }
}
await import('../lib/client.js')

if (loaded === null) {
  console.log('  FAIL клиентская половина не зарегистрировалась в загрузчике')
  process.exit(1)
}
check('модуль объявлен под своим именем', loaded.id === 'dsh-engram-memory', String(loaded.id))

// ── стенд: React ─────────────────────────────────────────────────────────────
const jsx = (type, props) => ({ type, props: props ?? {} })
const jsxs = (type, props) => ({ type, props: props ?? {} })

function makeReact(values) {
  let index = 0
  return {
    useState: () => [values[index++], () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: null })
  }
}

const fakeRequire = (name) => {
  if (name === 'react') return makeReact([null, null, false, 0, '', null, false, false])
  if (name === 'react/jsx-runtime') return { jsx, jsxs }
  return {}
}

const client = loaded.factory(fakeRequire)
check('клиентская половина требует службу слотов', JSON.stringify(client.inject) === '["slots"]', JSON.stringify(client.inject))
check('есть точка входа apply', typeof client.apply === 'function')

// ── стенд: клиентский контекст со слотами ────────────────────────────────────
let registration = null
const clientContext = {
  slots: {
    inject: (name, callback) => callback(),
    register: (spec, component) => {
      registration = { spec, component }
      return { dispose: () => {} }
    }
  }
}
client.apply(clientContext)
check('вкладка объявлена в настройках', registration?.spec?.name === 'settings.section', JSON.stringify(registration?.spec))
check('id вкладки — наш', registration?.spec?.id === 'engram-memory', String(registration?.spec?.id))
check('подпись вкладки — «Память Engram»', registration?.spec?.label?.() === 'Память Engram', String(registration?.spec?.label?.()))
check('вкладка после параметров проекта', registration?.spec?.order === 56, String(registration?.spec?.order))

/** Поиск в дереве разметки: функции-компоненты раскрываем так же, как это делает React. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  visit(node)
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  const props = node.props ?? {}
  for (const key of Object.keys(props)) {
    if (key === 'dangerouslySetInnerHTML') continue
    walk(props[key], visit)
  }
}
const texts = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (typeof node.props?.children === 'string') list.push(node.props.children)
  })
  return list.join(' | ')
}
const buttons = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (node.type === 'button') list.push(node)
  })
  return list
}
const barWidth = (tree) => {
  let width = null
  walk(tree, (node) => {
    if (node.props?.className === 'pem-bar__fill') width = node.props.style?.width
  })
  return width
}
/** Кнопки своих выпадающих списков: системных <select> в разметке нет. */
const drops = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.includes('pem-drop__btn')) list.push(node)
  })
  return list
}
const dropItems = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.includes('pem-drop__item')) list.push(node)
  })
  return list
}
/** Сами выпадающие списки: у них и смотрим признак «скрыт». */
const dropLists = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string' && node.props.className.includes('pem-drop__list')) list.push(node)
  })
  return list
}

// ── рендер: необработанные заметки ───────────────────────────────────────────
const stateWithWork = {
  ok: true,
  workspace: 'D:/demo',
  projects: [
    { project: 'hrm1', total: 40, processed: 35, unprocessed: 5, cards: 3, bar: 35 / 40 },
    { project: 'demo', total: 12, processed: 5, unprocessed: 7, cards: 2, bar: 5 / 12 }
  ],
  notes: { total: 52, processed: 40, unprocessed: 12, cards: 5, bar: 40 / 52 },
  estimate: {
    planned: 12,
    passes: 3,
    maxPasses: 3,
    capped: true,
    perPassNotes: 20,
    perPassTokens: 4200,
    tokens: 12600,
    charsPerToken: 3,
    projects: [{ project: 'demo', unprocessed: 7 }]
  },
  model: { provider: 'ollama', model: 'qwen3-30b', reasoningEffort: 'off' },
  mcp: { declared: true, harnessVersion: '2.0.0', packageVersion: '2.1.0', needsRestart: true },
  job: {
    running: false,
    error: null,
    report: 'Сведено 12 из 12 заметок → 5 карточек-выводов за 3 прохода. Токенов: 41 200.\nКарточки легли в проект: demo — 5.\n• Диаризация: выбор движка · 2 заметки',
    saved: [{ title: 'Диаризация: выбор движка', sources: [1, 2] }]
  }
}

/** Компонент берём из регистрации, хуки подставляем на каждый рендер заново. */
const renderWith = (state) => {
  let registrationLocal = null
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, component) => {
        registrationLocal = component
        return {}
      }
    }
  }
  loaded.factory((name) => (name === 'react' ? makeReact([state, null, false, 0, '', null, false, false]) : name === 'react/jsx-runtime' ? { jsx, jsxs } : {})).apply(ctx)
  return registrationLocal()
}

/** Тот же рендер, но с готовым списком моделей от хоста; `open` открывает список проектов. */
const renderWithModels = (state, models, open = false) => {
  let registrationLocal = null
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, component) => {
        registrationLocal = component
        return {}
      }
    }
  }
  loaded.factory((name) => (name === 'react' ? makeReact([state, null, false, 0, '', models, open, false]) : name === 'react/jsx-runtime' ? { jsx, jsxs } : {})).apply(ctx)
  return registrationLocal()
}

const tree = renderWith(stateWithWork)
const text = texts(tree)
check('кнопка названа «Обработать заметки»', text.includes('Обработать заметки'), text.slice(0, 200))
check('видно, сколько заметок не обработано', text.includes('12') && text.includes('из 52 заметок ещё не сведены в выводы'), text)
check('карточек-выводов указано число', text.includes('карточек-выводов: 5'), text)
check('полоска заполнена по доле сведённых во всех проектах', barWidth(tree) === '76.9%', String(barWidth(tree)))
check('отчёт последнего прохода виден', text.includes('Сведено 12 из 12 заметок → 5 карточек-выводов за 3 прохода.'), text)
check('многострочный отчёт читается строками', text.includes('Карточки легли в проект: demo — 5.'), text)
check('карточка названа со числом усвоенных заметок', text.includes('Диаризация: выбор движка · 2 заметки'), text)
check('карточки не повторяются дважды', text.split('Диаризация: выбор движка').length === 2, text)
check('во вкладке не осталось слов про «сырые заметки»', !text.includes('Сырые заметки'), text)
check('состояние MCP названо явно', text.includes('MCP-сервер') && text.includes('объявлен'), text)
check('проекты видны в выборе, с числами', text.includes('hrm1 · 5') && text.includes('demo · 7'), text)
check('обнулённый проект снимает фильтр, а не оставляет пустое поле', source.includes("(data.projects ?? []).some((bucket) => bucket.project === value)") && source.includes('setChoice(\'\')') && source.includes('placeholder: `все проекты · ${unprocessed}`'), 'правки фильтра нет')
check('во вкладке нет объяснений и истории решений', !/Проекты берутся из базы|а не из открытых окон|собственных ключей|Последний рабочий каталог|Сырые заметки остаются|оценка по \d+ знака|MCP обязателен|Бинарь|memory-consolidate/u.test(text), text)
check('строка версии названа по-человечески', text.includes('Версия Engram'), text)
check('у обоих полей есть подписи', texts(tree).includes('Проект') && texts(tree).includes('Модель'), text)
check('список проектов закрыт, пока его не открыли', dropLists(tree).length === 1 && dropLists(tree).every((list) => list.props.hidden === true), String(dropLists(tree).length))
check('закрытый список прячется правилом, а не одним атрибутом', source.includes('.pem-drop__list[hidden] { display: none; }'))
check('цена нажатия показана до нажатия', text.includes('3 прохода · до 20 заметок за проход · ≈12 600 токенов'), text)
check('вкладка не показывает сводку гигиены: человеку нужны очередь и кнопка, а не термины', text.includes('Гигиена:') === false && text.includes('усвоено выводами') === false, text.slice(0, 300))
check('предел проходов назван коротко', text.includes('остаток — следующим нажатием'), text)
check('выбор проекта есть, и по умолчанию — все', drops(tree).length === 1 && texts(drops(tree)[0]).includes('все проекты · 12'), texts(drops(tree)[0]))
check('в выборе перечислены проекты очереди', dropItems(tree).some((item) => item.props.children === 'hrm1 · 5') && dropItems(tree).some((item) => item.props.children === 'demo · 7'), texts(tree))
check('модель обработки показана даже без списка моделей', text.includes('ollama / qwen3-30b'), text)
check('расхождение бинаря объяснено', text.includes('обновится после перезапуска'), text)
check('когда всё объявлено, предупреждения про MCP нет', text.includes('MCP обязателен') === false && text.includes('объявлен'), text)
check('кнопка доступна, когда есть что обрабатывать', buttons(tree).every((button) => button.props.disabled !== true))

// ── рендер: служба моделей отдала список ─────────────────────────────────────
const modelTree = renderWithModels(stateWithWork, [
  { provider: 'ollama', model: 'qwen3-30b' },
  { provider: 'zai', model: 'glm-5.3-flash' }
])
const modelText = texts(modelTree)
check('модель можно выбрать на месте', drops(modelTree).length === 2, String(drops(modelTree).length))
check('выбор модели подписан текущей моделью', modelText.includes('ollama / qwen3-30b'), modelText)
check('в выборе есть модели из службы', dropItems(modelTree).some((item) => item.props.children === 'zai / glm-5.3-flash'), modelText)

// ── рендер: текущая модель не попала в список от службы ──────────────────────
const outsideTree = renderWithModels(stateWithWork, [{ provider: 'zai', model: 'glm-5.3-flash' }])
check('модель вне списка всё равно подписана', texts(outsideTree).includes('ollama / qwen3-30b'), texts(outsideTree))

// ── рендер: список проектов открыт ───────────────────────────────────────────
const openTree = renderWithModels(stateWithWork, [{ provider: 'ollama', model: 'qwen3-30b' }], true)
check('два списка закрыты, пока их не открыли', dropLists(modelTree).length === 2 && dropLists(modelTree).every((list) => list.props.hidden === true), String(dropLists(modelTree).length))
check('открытый список показан, соседний остаётся закрытым', dropLists(openTree)[0].props.hidden === false && dropLists(openTree)[1].props.hidden === true, `${dropLists(openTree)[0].props.hidden}/${dropLists(openTree)[1].props.hidden}`)
check('в выборе отмечен текущий пункт', dropItems(openTree).some((item) => item.props['aria-selected'] === true && item.props.children === 'все проекты · 12'), texts(openTree))

// ── рендер: проход идёт ──────────────────────────────────────────────────────
const runningTree = renderWith({
  ...stateWithWork,
  estimate: null,
  job: {
    running: true,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    progress: { pass: 2, passes: 3, processed: 14, total: 19, left: 5, cards: 3 },
    error: null,
    report: null,
    saved: []
  }
})
const runningText = texts(runningTree)
check('во время прохода видно, какой он по счёту и сколько сведено', runningText.includes('проход 2 из 3, сведено 14 из 19'), runningText)
check('во время прохода есть отмена', buttons(runningTree).some((button) => button.props.children === 'Отменить'), runningText)
check('кнопка обработки занята и подписана', buttons(runningTree).some((button) => button.props.disabled === true && button.props.children === 'Обрабатываю…'))
check('выбор проекта во время прохода заблокирован', drops(runningTree)[0].props.disabled === true)

// ── рендер: всё обработано ───────────────────────────────────────────────────
const doneTree = renderWith({ ...stateWithWork, notes: { total: 12, processed: 12, unprocessed: 0, cards: 4, bar: 1 }, projects: [], job: { running: false, error: null, report: null, saved: [] } })
const doneText = texts(doneTree)
check('при нуле необработанных сказано прямо', doneText.includes('все сведены в выводы'), doneText)
check('выбор проекта остаётся и при пустой очереди', doneText.includes('все проекты · 0'), doneText)
check('и кнопка заблокирована', buttons(doneTree).some((button) => button.props.disabled === true && button.props.title === 'Все заметки уже сведены в выводы'))

// ── рендер: заметок нет ──────────────────────────────────────────────────────
const emptyTree = renderWith({
  ok: true,
  workspace: '',
  projects: [],
  notes: { total: 0, processed: 0, unprocessed: 0, cards: 0, bar: 0 },
  estimate: { planned: 0, passes: 0, maxPasses: 3, capped: false, perPassNotes: 0, perPassTokens: 0, tokens: 0, charsPerToken: 3, projects: [] },
  model: null,
  mcp: { declared: false },
  job: { running: false, error: null, report: null, saved: [] }
})
check('пустая память объяснена', texts(emptyTree).includes('заметок в базе нет'), texts(emptyTree))
check('необъявленный MCP назван честно', texts(emptyTree).includes('не объявлен'), texts(emptyTree))
check('про необъявленный MCP есть предупреждение', texts(emptyTree).includes('Без MCP-сервера модель не сможет искать и пополнять память сама'), texts(emptyTree))
check('если модель не выбрана — сказано прямо', texts(emptyTree).includes('не выбрана'), texts(emptyTree))
check('без несведённых заметок цена не выдумывается', texts(emptyTree).includes('Несведённых заметок нет.'), texts(emptyTree))

// ── рендер: ошибка прохода ───────────────────────────────────────────────────
const errorTree = renderWith({ ...stateWithWork, job: { running: false, error: 'провайдер недоступен', report: null, saved: [] } })
const errorText = texts(errorTree)
check('ошибка показана там, где нажимали', errorText.includes('Обработать заметки не удалось') && errorText.includes('провайдер недоступен'), errorText)

// ── разметка: полоска считает проценты от 0 до 100 ───────────────────────────
const overTree = renderWith({ ...stateWithWork, notes: { total: 3, processed: 9, unprocessed: 0, cards: 1, bar: 3 } })
check('полоска не выходит за 100%', barWidth(overTree) === '100.0%', String(barWidth(overTree)))

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
