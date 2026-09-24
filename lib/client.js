// dsh-engram-memory — клиентская половина.
//
// Вкладка «Память» в настройках: сколько заметок ещё не сведено в выводы, кнопка
// «Обработать заметки», отчёт последнего прохода и состояние подключения MCP.
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
.pem-btn--ghost:not(:disabled):hover { background: rgba(127,127,127,.12); }
.pem-btn:disabled { cursor: not-allowed; }
/* Недоступная кнопка должна читаться: гасим фон, а не подпись. */
.pem-btn--primary:disabled { background: color-mix(in srgb, var(--pem-primary, #3964fe) 45%, transparent); color: rgba(255,255,255,.9); }
.pem-btn:focus-visible { outline: 2px solid var(--pem-primary, #3964fe); outline-offset: 1px; }
.pem-result { border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.pem-result__head { font-size: 13px; font-weight: 600; line-height: 1.45; }
.pem-result--error .pem-result__head { color: #e57373; }
.pem-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; opacity: .85; }
.pem-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; line-height: 1.6; }
.pem-ok { color: #4caf7d; }
.pem-warn { color: #d8a15a; }
.pem-link { color: inherit; text-decoration: underline; }
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

    /** Прошедшее время прохода: минута ожидания без счётчика читается как зависание. */
    const elapsed = (startedAt) => {
      if (typeof startedAt !== 'string') return ''
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
      return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
    }

    function Section() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [tick, setTick] = useState(0)
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

      const run = async () => {
        setBusy(true)
        try {
          await request('/run', { method: 'POST', body: '{}' })
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

      if (state === null) {
        return jsxs('div', { className: 'pem-root', children: [
          Styles(),
          jsx('p', { className: 'pem-muted', children: error ?? 'Читаю состояние памяти…' })
        ] })
      }

      const notes = state.notes ?? {}
      const job = state.job ?? {}
      const mcp = state.mcp ?? {}
      const unprocessed = Number(notes.unprocessed) || 0
      const total = Number(notes.total) || 0
      const done = Number(notes.processed) || 0
      const cards = Number(notes.cards) || 0

      const result = job.error
        ? jsxs('div', { className: 'pem-result pem-result--error', children: [
            jsx('div', { className: 'pem-result__head', children: 'Обработать заметки не удалось' }),
            jsx('p', { className: 'pem-muted', children: job.error })
          ] })
        : job.report
          ? jsxs('div', { className: 'pem-result', children: [
              jsx('div', { className: 'pem-result__head', children: job.report }),
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

      const connectionRows = [
        jsx('div', { className: 'pem-row', key: 'server', children: [
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
        jsxs('div', { className: 'pem-row', key: 'tools', children: [
          jsx('span', { children: 'Инструменты модели' }),
          jsx('span', {
            className: mcp.declared ? 'pem-ok' : 'pem-warn',
            children: mcp.declared ? 'через MCP-сервер' : 'только правила и автосохранение'
          })
        ] })
      ]

      return jsxs('div', { className: 'pem-root', children: [
        Styles(),
        jsxs(Card, {
          title: 'Проект',
          children: [
            jsxs('div', { className: 'pem-row', children: [
              jsx('span', { children: 'Обрабатываем заметки проекта' }),
              jsx('span', { title: state.workspace ?? '', children: state.project ?? 'не определён' })
            ] }),
            jsxs('div', { className: 'pem-row', children: [
              jsx('span', { children: 'Модель обработки' }),
              jsx('span', {
                children: state.model
                  ? `${state.model.provider} / ${state.model.model}`
                  : 'не выбрана — задайте модель по умолчанию в настройках'
              })
            ] }),
            jsx('p', { className: 'pem-muted', children: 'Одна кнопка обрабатывает один проект — тот, что указан выше. Модель берётся из настроек DSH («Модели»), собственных ключей у плагина нет.' })
          ]
        }),
        jsxs(Card, {
          title: 'Заметки',
          headExtra: jsx('span', { className: 'pem-muted', children: cards > 0 ? `карточек-выводов: ${cards}` : 'карточек-выводов пока нет' }),
          children: [
            jsxs('div', { className: 'pem-counts', children: [
              jsx('span', { className: 'pem-count', children: String(unprocessed) }),
              jsx('span', { className: 'pem-muted', children: total === 0
                ? 'заметок у этого проекта нет — обрабатывать нечего'
                : unprocessed === 0
                  ? `из ${total} заметок: все сведены в выводы`
                  : `из ${total} заметок ещё не сведены в выводы` })
            ] }),
            jsx(Bar, { value: notes.bar }),
            jsx('div', { className: 'pem-actions', children: [
              jsx(Btn, {
                variant: 'primary',
                disabled: busy || job.running === true || unprocessed === 0,
                title: unprocessed === 0 ? 'Все заметки уже сведены в выводы' : 'Свести заметки проекта в карточки-выводы',
                onClick: run,
                children: job.running === true ? 'Обрабатываю…' : 'Обработать заметки'
              }),
              job.running === true
                ? jsx(Btn, { onClick: cancel, children: 'Отменить' })
                : null,
              job.running === true
                ? jsx('span', { className: 'pem-muted', children: '- ' + elapsed(job.startedAt) + ` (проверка ${tick})` })
                : null
            ] }),
            jsx('p', { className: 'pem-muted', children: `Сведено: ${done} из ${total}. Сырые заметки остаются на месте — вывод ложится рядом.` }),
            result
          ]
        }),
        jsxs(Card, {
          title: 'Подключение',
          children: [
            ...connectionRows,
            jsx('p', { className: 'pem-muted', children: 'MCP нужен модели, чтобы самой искать и писать в память — в том числе в общий слой. Без сервера работают правила, подача и автосохранение в проект, но наполнять общий слой модели нечем.' }),
            jsx('p', { className: 'pem-muted', children: 'То же действие доступно командой /memory-consolidate и аргументом «черновик» — показать вывод, ничего не записывая.' })
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
            label: () => 'Память',
            registrant: 'dsh-engram-memory'
          },
          Section
        )
      )
    }

    return { apply, inject: ['slots'] }
  }
})
