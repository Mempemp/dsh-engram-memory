// Проверка клиентской половины без браузера: загрузчик DSH подделываем, хуки
// React — заглушками, а дерево разметки разбираем как данные. Так ловятся вещи,
// которых не видит ни один синтаксический контроль: подписи кнопок, числа в
// полоске, тексты ошибок и то, что кнопка действительно блокируется.
let failures = 0
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
  if (name === 'react') return makeReact([null, null, false, 0])
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
check('подпись вкладки — «Память»', registration?.spec?.label?.() === 'Память', String(registration?.spec?.label?.()))
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

// ── рендер: необработанные заметки ───────────────────────────────────────────
const stateWithWork = {
  ok: true,
  project: 'demo',
  workspace: 'D:/demo',
  notes: { total: 12, processed: 5, unprocessed: 7, cards: 2, bar: 5 / 12 },
  model: { provider: 'ollama', model: 'qwen3-30b', reasoningEffort: 'off' },
  mcp: { declared: true, harnessVersion: '2.0.0', packageVersion: '2.1.0', needsRestart: true },
  job: { running: false, error: null, report: 'Обработано 7 заметок → 2 карточки.', saved: [{ title: 'Диаризация: выбор движка', sources: [1, 2] }] }
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
  loaded.factory((name) => (name === 'react' ? makeReact([state, null, false, 0]) : name === 'react/jsx-runtime' ? { jsx, jsxs } : {})).apply(ctx)
  return registrationLocal()
}

const tree = renderWith(stateWithWork)
const text = texts(tree)
check('кнопка названа «Обработать заметки»', text.includes('Обработать заметки'), text.slice(0, 200))
check('видно, сколько заметок не обработано', text.includes('7') && text.includes('из 12 заметок ещё не сведены в выводы'), text)
check('карточек-выводов указано число', text.includes('карточек-выводов: 2'), text)
check('полоска заполнена по доле сведённых', barWidth(tree) === '41.7%', String(barWidth(tree)))
check('отчёт последнего прохода виден', text.includes('Обработано 7 заметок → 2 карточки.'), text)
check('источники карточки показаны', text.includes('Диаризация: выбор движка ← #1, #2'), text)
check('состояние MCP названо явно', text.includes('MCP-сервер') && text.includes('объявлен'), text)
check('проект назван там, где кнопка', text.includes('Обрабатываем заметки проекта') && text.includes('demo'), text)
check('сказано, что кнопка работает по одному проекту', text.includes('Одна кнопка обрабатывает один проект'), text)
check('модель обработки показана', text.includes('ollama / qwen3-30b'), text)
check('расхождение бинаря объяснено', text.includes('обновится после перезапуска'), text)
check('сказано, зачем нужен MCP', text.includes('MCP нужен модели'), text)
check('упомянута команда для тех, кто ей пользуется', text.includes('/memory-consolidate'), text)
check('кнопка доступна, когда есть что обрабатывать', buttons(tree).every((button) => button.props.disabled !== true))

// ── рендер: всё обработано ───────────────────────────────────────────────────
const doneTree = renderWith({ ...stateWithWork, notes: { total: 12, processed: 12, unprocessed: 0, cards: 4, bar: 1 }, job: { running: false, error: null, report: null, saved: [] } })
const doneText = texts(doneTree)
check('при нуле необработанных сказано прямо', doneText.includes('все сведены в выводы'), doneText)
check('и кнопка заблокирована', buttons(doneTree).some((button) => button.props.disabled === true && button.props.title === 'Все заметки уже сведены в выводы'))

// ── рендер: заметок нет ──────────────────────────────────────────────────────
const emptyTree = renderWith({ ok: true, project: 'demo', workspace: '', notes: { total: 0, processed: 0, unprocessed: 0, cards: 0, bar: 0 }, model: null, mcp: { declared: false }, job: { running: false, error: null, report: null, saved: [] } })
check('пустая память объяснена', texts(emptyTree).includes('обрабатывать нечего'), texts(emptyTree))
check('необъявленный MCP назван честно', texts(emptyTree).includes('не объявлен'), texts(emptyTree))
check('если модель не выбрана — сказано прямо', texts(emptyTree).includes('не выбрана — задайте модель по умолчанию'), texts(emptyTree))

// ── рендер: ошибка прохода ───────────────────────────────────────────────────
const errorTree = renderWith({ ...stateWithWork, job: { running: false, error: 'провайдер недоступен', report: null, saved: [] } })
const errorText = texts(errorTree)
check('ошибка показана там, где нажимали', errorText.includes('Обработать заметки не удалось') && errorText.includes('провайдер недоступен'), errorText)

// ── разметка: полоска считает проценты от 0 до 100 ───────────────────────────
const overTree = renderWith({ ...stateWithWork, notes: { total: 3, processed: 9, unprocessed: 0, cards: 1, bar: 3 } })
check('полоска не выходит за 100%', barWidth(overTree) === '100.0%', String(barWidth(overTree)))

console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
