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
  if (name === 'react') return makeReact([null, null, false, 0, ''])
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
const selects = (tree) => {
  const list = []
  walk(tree, (node) => {
    if (node.type === 'select') list.push(node)
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
    report: 'Сведено 12 из 12 заметок → 5 карточк(и) за 3 прохода.\nПроекты: demo — 7, hrm1 — 5',
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
  loaded.factory((name) => (name === 'react' ? makeReact([state, null, false, 0, '']) : name === 'react/jsx-runtime' ? { jsx, jsxs } : {})).apply(ctx)
  return registrationLocal()
}

const tree = renderWith(stateWithWork)
const text = texts(tree)
check('кнопка названа «Обработать заметки»', text.includes('Обработать заметки'), text.slice(0, 200))
check('видно, сколько заметок не обработано', text.includes('12') && text.includes('из 52 заметок ещё не сведены в выводы'), text)
check('карточек-выводов указано число', text.includes('карточек-выводов: 5'), text)
check('полоска заполнена по доле сведённых во всех проектах', barWidth(tree) === '76.9%', String(barWidth(tree)))
check('отчёт последнего прохода виден', text.includes('Сведено 12 из 12 заметок → 5 карточк(и) за 3 прохода.'), text)
check('многострочный отчёт читается строками', text.includes('Проекты: demo — 7, hrm1 — 5'), text)
check('источники карточки показаны', text.includes('Диаризация: выбор движка ← #1, #2'), text)
check('состояние MCP названо явно', text.includes('MCP-сервер') && text.includes('объявлен'), text)
check('проекты перечислены с числами', text.includes('hrm1') && text.includes('7 из 12 ещё не сведены'), text)
check('сказано, что очередь берётся из базы', text.includes('Проекты берутся из базы'), text)
check('цена нажатия показана до нажатия', text.includes('Будет проходов: 3') && text.includes('12 600 токенов на входе'), text)
check('вкладка не показывает сводку гигиены: человеку нужны очередь и кнопка, а не термины', text.includes('Гигиена:') === false && text.includes('усвоено выводами') === false, text.slice(0, 300))
check('предел проходов объяснён', text.includes('остаток обрабатывается следующим нажатием'), text)
check('рабочий каталог назван', text.includes('Последний рабочий каталог: D:/demo'), text)
check('выбор одного проекта есть, и по умолчанию — все', selects(tree).length === 1 && texts(selects(tree)[0]).includes('все проекты'), texts(selects(tree)[0]))
check('в выборе перечислены проекты очереди', texts(selects(tree)[0]).includes('hrm1') && texts(selects(tree)[0]).includes('demo'), texts(selects(tree)[0]))
check('модель обработки показана', text.includes('ollama / qwen3-30b'), text)
check('расхождение бинаря объяснено', text.includes('обновится после перезапуска'), text)
check('сказано, зачем нужен MCP', text.includes('MCP обязателен'), text)
check('упомянута команда для тех, кто ей пользуется', text.includes('/memory-consolidate'), text)
check('кнопка доступна, когда есть что обрабатывать', buttons(tree).every((button) => button.props.disabled !== true))

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
check('выбор проекта во время прохода заблокирован', selects(runningTree)[0].props.disabled === true)

// ── рендер: всё обработано ───────────────────────────────────────────────────
const doneTree = renderWith({ ...stateWithWork, notes: { total: 12, processed: 12, unprocessed: 0, cards: 4, bar: 1 }, projects: [], job: { running: false, error: null, report: null, saved: [] } })
const doneText = texts(doneTree)
check('при нуле необработанных сказано прямо', doneText.includes('все сведены в выводы'), doneText)
check('пустая очередь названа пустой', doneText.includes('обрабатывать нечего') && doneText.includes('очередь пуста'), doneText)
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
check('про необъявленный MCP есть предупреждение', texts(emptyTree).includes('MCP-сервер не объявлен') && texts(emptyTree).includes('общий слой наполнять нечем'), texts(emptyTree))
check('если модель не выбрана — сказано прямо', texts(emptyTree).includes('не выбрана — задайте модель по умолчанию'), texts(emptyTree))
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
