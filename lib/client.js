// dsh-engram-memory — клиентская половина.
//
// Вкладка «Память Engram» в настройках: сколько заметок не сведено в выводы,
// кнопка «Обработать заметки», выбор проекта и модели обработки, отчёт
// последнего прохода и состояние подключения MCP.
//
// Правило разметки: показываем только то, что человек может сделать или что
// требует вмешательства. Пояснений «как это работает» и историй «а раньше было
// иначе» здесь нет. Списков, которые растут вместе с базой (все проекты,
// все модели), тоже нет — они живут в выпадающих списках.
//
// Никакой сборки: React приходит из рантайма DSH, разметка — plain JS, стили —
// один инжектируемый <style> с классами pem-* (он даёт hover/focus/disabled,
// чего инлайновые стили не выражают).
window.__ModuleLoader__.load({
  id: 'dsh-engram-memory',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/engram-memory'

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const detail = (data && data.error) || response.statusText || 'HTTP ' + response.status
        // 404 без тела — это рассинхрон половин: клиентская подхватывается
        // перезагрузкой страницы, хост-часть — только стартом DSH.
        if (response.status === 404 && data === null) {
          throw new Error(
            'DSH не знает маршрут ' + API + path + ' (' + detail + '): в запущенном процессе старая хост-часть плагина. ' +
            'Перезапустите DSH — клиентская половина обновляется перезагрузкой страницы, хост-часть только при старте.'
          )
        }
        throw new Error(detail)
      }
      return data
    }

    const STYLE = `
.pem-root { display: flex; flex-direction: column; gap: 12px; font-family: var(--dsw-font-family, inherit); }
.pem-card { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); border-radius: 12px; padding: 14px; background: rgba(127,127,127,.04); display: flex; flex-direction: column; gap: 12px; }
.pem-card__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.pem-title { font-size: 14px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary, inherit); }
.pem-muted { font-size: 12px; line-height: 1.5; opacity: .72; }
.pem-counts { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.pem-count { font-size: 20px; font-weight: 600; line-height: 1.2; color: var(--dsw-alias-label-primary, inherit); }
.pem-bar { height: 8px; border-radius: 999px; background: rgba(127,127,127,.2); overflow: hidden; }
.pem-bar__fill { height: 100%; border-radius: 999px; background: var(--pem-primary, #3964fe); transition: width .25s ease; }
.pem-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pem-btn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: var(--dsw-font-family, inherit); font-size: 13px; font-weight: 500; line-height: 1.45; transition: background-color .12s ease, border-color .12s ease, filter .12s ease; }
.pem-btn--primary { background: var(--pem-primary, #3964fe); color: #fff; }
.pem-btn--primary:not(:disabled):hover { filter: brightness(1.08); }
.pem-btn--ghost { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.35)); }
.pem-btn--ghost:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.pem-btn:disabled { cursor: not-allowed; }
/* Недоступная кнопка должна читаться: гасим фон, а не подпись. */
.pem-btn--primary:disabled { background: color-mix(in srgb, var(--pem-primary, #3964fe) 45%, transparent); color: rgba(255,255,255,.9); }
.pem-btn:focus-visible { outline: 2px solid var(--pem-primary, #3964fe); outline-offset: 1px; }
.pem-result { border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.pem-result__head { font-size: 13px; font-weight: 600; line-height: 1.45; }
.pem-result--error .pem-result__head { color: var(--dsw-alias-state-error-primary, #e57373); }
.pem-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; opacity: .85; }
.pem-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; line-height: 1.6; }
.pem-chip { display: inline-flex; align-items: center; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); font-size: 13px; }
/* Свой выпадающий список: системный <select> рисует сама система, и в тёмной теме его список выпадает белым. */
.pem-drop { position: relative; }
.pem-drop__btn { max-width: 280px; justify-content: space-between; }
.pem-drop__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pem-drop__caret { opacity: .55; font-size: 10px; line-height: 1; }
.pem-drop__list { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 100%; max-width: 380px; max-height: 280px; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #232326); box-shadow: 0 10px 28px rgba(0,0,0,.32); }
.pem-drop__item { height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--dsw-font-family, inherit); font-size: 13px; line-height: 1.4; }
.pem-drop__item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); }
.pem-drop__item--on { background: color-mix(in srgb, var(--pem-primary, #3964fe) 22%, transparent); }
.pem-ok { color: #4caf7d; }
.pem-warn { color: #d8a15a; }
`

    function Styles() {
      return jsx('style', { dangerouslySetInnerHTML: { __html: STYLE } })
    }

    function Btn(props) {
      return jsx('button', {
        type: 'button',
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        className: 'pem-btn pem-btn--' + (props.variant || 'ghost'),
        children: props.children
      })
    }

    function Card(props) {
      return jsxs('section', {
        className: 'pem-card',
        children: [
          props.title === undefined
            ? null
            : jsxs('div', { className: 'pem-card__head', children: [
                jsx('div', { className: 'pem-title', children: props.title }),
                props.headExtra ?? null
              ] }),
          ...(Array.isArray(props.children) ? props.children : [props.children])
        ]
      })
    }

    function Bar(props) {
      const value = Math.max(0, Math.min(1, Number(props.value) || 0))
      return jsx('div', {
        className: 'pem-bar',
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(value * 100),
        children: jsx('div', { className: 'pem-bar__fill', style: { width: (value * 100).toFixed(1) + '%' } })
      })
    }

    /**
     * Выпадающий список свой, а не `<select>`: системный список рисует сама
     * система и в тёмной теме выпадает белым прямоугольником. Закрытый список
     * остаётся в разметке (`hidden`), поэтому его содержимое видно проверкам
     * без браузера.
     */
    function Dropdown(props) {
      const [open, setOpen] = useState(false)
      const box = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const away = (event) => {
          if (box.current !== null && !box.current.contains(event.target)) setOpen(false)
        }
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', away)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('mousedown', away)
          document.removeEventListener('keydown', escape)
        }
      }, [open])
      const items = Array.isArray(props.items) ? props.items : []
      const current = items.find((item) => item.value === props.value)
      return jsxs('div', { className: 'pem-drop', ref: box, children: [
        jsxs('button', {
          type: 'button',
          className: 'pem-btn pem-btn--ghost pem-drop__btn',
          disabled: props.disabled,
          title: props.title,
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
          children: [
            jsx('span', { className: 'pem-drop__label', children: current === undefined ? props.placeholder : current.label }),
            jsx('span', { className: 'pem-drop__caret', 'aria-hidden': 'true', children: '▾' })
          ]
        }),
        jsx('div', {
          className: 'pem-drop__list',
          role: 'listbox',
          hidden: !open,
          children: items.map((item) =>
            jsx('button', {
              key: String(item.value),
              type: 'button',
              role: 'option',
              'aria-selected': item.value === props.value,
              className: 'pem-drop__item' + (item.value === props.value ? ' pem-drop__item--on' : ''),
              onClick: () => {
                setOpen(false)
                props.onPick(item.value)
              },
              children: item.label
            })
          )
        })
      ] })
    }

    /** Прошедшее время прохода: минута ожидания без счётчика читается как зависание. */
    const elapsed = (startedAt) => {
      if (typeof startedAt !== 'string') return ''
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
      return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
    }

    /** Число с разделителями разрядов: «14 200» читается быстрее, чем «14200». */
    const number = (value) => String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

    /** Цена нажатия до того, как его нажали. Формулировки без падежей — числа бывают любые. */
    const estimateText = (estimate) => {
      if (estimate === null || estimate === undefined) return ''
      const planned = Number(estimate.planned) || 0
      if (planned === 0) return 'Несведённых заметок нет.'
      const tail = estimate.capped === true ? ' · остаток — следующим нажатием' : ''
      return `${Number(estimate.passes) || 0} прохода · до ${Number(estimate.perPassNotes) || 0} заметок за проход · ≈${number(estimate.tokens)} токенов${tail}`
    }

    const modelLabel = (model) => (model === null || model === undefined ? '' : `${model.provider} / ${model.model}`)

    function Section() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [tick, setTick] = useState(0)
      const [choice, setChoice] = useState('')
      const [models, setModels] = useState(null)
      const timer = useRef(null)

      const load = useCallback(async () => {
        try {
          const data = await request('/state')
          setState(data)
          setError(null)
        } catch (problem) {
          setError(problem.message)
        }
      }, [])

      useEffect(() => {
        load()
        return () => {
          if (timer.current !== null) clearInterval(timer.current)
        }
      }, [load])

      // Список моделей спрашиваем один раз: он меняется только настройками DSH.
      useEffect(() => {
        let alive = true
        request('/models')
          .then((data) => {
            if (alive) setModels(Array.isArray(data.models) ? data.models : [])
          })
          .catch(() => {
            if (alive) setModels([])
          })
        return () => {
          alive = false
        }
      }, [])

      const running = state?.job?.running === true
      useEffect(() => {
        if (timer.current !== null) {
          clearInterval(timer.current)
          timer.current = null
        }
        if (!running) return undefined
        timer.current = setInterval(() => {
          setTick((value) => value + 1)
          load()
        }, 1500)
        return () => {
          if (timer.current !== null) {
            clearInterval(timer.current)
            timer.current = null
          }
        }
      }, [running, load])

      // Сужение до одного проекта — необязательное: без него кнопка проходит по
      // всем проектам базы порциями.
      const run = async () => {
        setBusy(true)
        try {
          await request('/run' + (choice === '' ? '' : '?project=' + encodeURIComponent(choice)), { method: 'POST', body: '{}' })
          await load()
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }

      const cancel = async () => {
        try {
          await request('/cancel', { method: 'POST', body: '{}' })
          await load()
        } catch (problem) {
          setError(problem.message)
        }
      }

      const pickModel = async (value) => {
        const picked = (models ?? []).find((item) => `${item.provider}/${item.model}` === value)
        if (picked === undefined) return
        setBusy(true)
        try {
          await request('/model', { method: 'POST', body: JSON.stringify({ provider: picked.provider, model: picked.model }) })
          await load()
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }

      if (state === null) {
        return jsxs('div', { className: 'pem-root', children: [
          Styles(),
          jsx('p', { className: 'pem-muted', children: error ?? 'Читаю состояние памяти…' })
        ] })
      }

      const notes = state.notes ?? {}
      const projects = Array.isArray(state.projects) ? state.projects : []
      const estimate = state.estimate ?? null
      const job = state.job ?? {}
      const progress = job.progress ?? null
      const mcp = state.mcp ?? {}
      const unprocessed = Number(notes.unprocessed) || 0
      const total = Number(notes.total) || 0
      const cards = Number(notes.cards) || 0
      const processing = job.running === true
      const reportLines = typeof job.report === 'string' && job.report !== '' ? job.report.split('\n') : []

      const result = job.error
        ? jsxs('div', { className: 'pem-result pem-result--error', children: [
            jsx('div', { className: 'pem-result__head', children: 'Обработать заметки не удалось' }),
            jsx('p', { className: 'pem-muted', children: job.error })
          ] })
        : reportLines.length > 0
          ? jsxs('div', { className: 'pem-result', children: [
              jsx('div', { className: 'pem-result__head', children: reportLines[0] }),
              ...reportLines.slice(1).map((line, index) =>
                jsx('p', { className: 'pem-muted', key: 'line-' + index, children: line })
              ),
              Array.isArray(job.saved) && job.saved.length > 0
                ? jsx('ul', { className: 'pem-list', children: job.saved.map((card, index) =>
                    jsx('li', {
                      key: 'card-' + index,
                      children: card.sources && card.sources.length > 0
                        ? `${card.title} ← ${card.sources.map((id) => '#' + id).join(', ')}`
                        : card.title
                    })
                  ) })
                : null
            ] })
          : null

      // Числа проектов живут в выпадающем списке: списком строк они бы выросли
      // вместе с базой и выдавили саму кнопку.
      const projectItems = [
        { value: '', label: `все проекты · ${unprocessed}` },
        ...projects.map((bucket) => ({ value: bucket.project, label: `${bucket.project} · ${bucket.unprocessed}` }))
      ]

      const modelItems = (models ?? []).map((item) => ({ value: `${item.provider}/${item.model}`, label: `${item.provider} / ${item.model}` }))
      const currentModel = modelLabel(state.model)

      return jsxs('div', { className: 'pem-root', children: [
        Styles(),
        jsxs(Card, {
          title: 'Обработка заметок',
          headExtra: jsx('span', { className: 'pem-muted', children: cards > 0 ? `карточек-выводов: ${cards}` : 'карточек-выводов пока нет' }),
          children: [
            jsxs('div', { className: 'pem-counts', children: [
              jsx('span', { className: 'pem-count', children: String(unprocessed) }),
              jsx('span', { className: 'pem-muted', children: total === 0
                ? 'заметок в базе нет'
                : unprocessed === 0
                  ? `из ${total} заметок: все сведены в выводы`
                  : `из ${total} заметок ещё не сведены в выводы` })
            ] }),
            jsx(Bar, { value: notes.bar }),
            jsxs('div', { className: 'pem-actions', children: [
              jsx(Btn, {
                variant: 'primary',
                disabled: busy || processing || unprocessed === 0,
                title: unprocessed === 0
                  ? 'Все заметки уже сведены в выводы'
                  : 'Свести заметки в карточки-выводы: одно нажатие проходит по проектам порциями',
                onClick: run,
                children: processing ? 'Обрабатываю…' : 'Обработать заметки'
              }),
              jsx(Dropdown, {
                items: projectItems,
                value: choice,
                disabled: processing,
                title: 'Пройти только по одному проекту',
                onPick: setChoice
              }),
              modelItems.length === 0
                ? jsx('span', { className: 'pem-chip', title: 'Модель обработки', children: currentModel === '' ? 'модель не выбрана' : currentModel })
                : jsx(Dropdown, {
                    items: modelItems,
                    value: currentModel,
                    disabled: processing || busy,
                    title: 'Модель обработки — та же, которой DSH отвечает в разговоре',
                    onPick: pickModel
                  }),
              processing
                ? jsx(Btn, { onClick: cancel, title: 'Отмена срабатывает между проходами: текущий дожидается модели', children: 'Отменить' })
                : null,
              processing
                ? jsx('span', { className: 'pem-muted', children: progress === null
                    ? 'готовлю порцию…'
                    : `проход ${progress.pass} из ${progress.passes}, сведено ${progress.processed} из ${progress.total}` })
                : null,
              processing
                ? jsx('span', { className: 'pem-muted', children: `- ${elapsed(job.startedAt)}` })
                : null
            ] }),
            jsx('p', { className: 'pem-muted', children: estimateText(estimate) }),
            result
          ]
        }),
        jsxs(Card, {
          title: 'Подключение',
          children: [
            jsxs('div', { className: 'pem-row', key: 'server', children: [
              jsx('span', { children: 'MCP-сервер' }),
              jsx('span', {
                className: mcp.declared ? 'pem-ok' : 'pem-warn',
                children: mcp.declared ? 'объявлен' : 'не объявлен'
              })
            ] }),
            jsxs('div', { className: 'pem-row', key: 'binary', children: [
              jsx('span', { children: 'Бинарь engram' }),
              jsx('span', { children: mcp.needsRestart
                ? `в харнессе ${mcp.harnessVersion ?? '—'}, в пакете ${mcp.packageVersion ?? '—'} — обновится после перезапуска`
                : (mcp.harnessVersion ?? mcp.packageVersion ?? '—') })
            ] }),
            mcp.declared === false
              ? jsx('p', { className: 'pem-warn', children: 'Без MCP-сервера модель не сможет искать и пополнять память сама: работают правила, подача и автосохранение в проект.' })
              : null
          ]
        }),
        error === null ? null : jsx('p', { className: 'pem-muted', children: error })
      ] })
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'engram-memory',
            order: 56,
            label: () => 'Память Engram',
            registrant: 'dsh-engram-memory'
          },
          Section
        )
      )
    }

    return { apply, inject: ['slots'] }
  }
})
