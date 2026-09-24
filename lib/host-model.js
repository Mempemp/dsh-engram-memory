/**
 * Вызов модели харнесса для вспомогательных проходов (обобщения памяти).
 *
 * Ключей здесь нет и не должно быть: маршрут (провайдер + модель) берётся у
 * живого агента, а креденшелы разрешает зарегистрированный адаптер DSH. Разговор
 * при этом не ведётся: вызов не привязывается к сессии — иначе вспомогательный
 * проход попал бы в историю ходов и в проверки сохранности сессии.
 */

const NO_REASONING_EFFORT = 'off'
const UNSUPPORTED_REASONING_EFFORT = 'UNSUPPORTED_REASONING_EFFORT'

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Маршрут модели у агента: провайдер, модель и заказанное усилие рассуждений. */
export function routeFromAgent(agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  let persisted
  try {
    persisted = agent.session?.requestHeader?.()
  } catch {
    persisted = undefined
  }
  const config = persisted?.config
  const provider = nonEmptyString(config?.provider) ?? nonEmptyString(agent.options?.provider)
  const model = nonEmptyString(config?.model) ?? nonEmptyString(agent.options?.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = nonEmptyString(config?.reasoningEffort) ?? nonEmptyString(agent.options?.reasoningEffort)
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/** Согласие на отмену: внешний сигнал (интерфейс) плюс свой предел времени. */
function linkedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('превышен предел времени')), timeoutMs) : null
  const outer = signal
  const onAbort = () => controller.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) onAbort()
    else outer.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      outer?.removeEventListener?.('abort', onAbort)
    }
  }
}

function mapUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const promptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const completionTokens = usage.outputTokens ?? 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function finishError(finish) {
  const kind = finish?.kind ?? 'unknown'
  if (kind === 'max-tokens') return new Error('модель упёрлась в предел вывода до конца ответа')
  if (kind === 'tool-calls') return new Error('модель запросила вызов инструментов вместо текста')
  if (kind === 'aborted') return new Error('вызов отменён')
  if (kind === 'error') return new Error(finish?.failure?.message ?? 'модель вернула ошибку')
  return new Error(`неожиданное завершение вывода: ${kind}`)
}

/**
 * Готовит функцию вызова модели. Возвращённая функция бросает Error с внятным
 * текстом — отчёт команды показывает его пользователю как есть.
 */
export function createHostModel(ctx, { defaultTimeoutMs = 90000, log = () => {} } = {}) {
  let dshLlm = null
  const load = async () => {
    if (dshLlm !== null) return dshLlm
    dshLlm = await import('@deepseek-ai/dsh-llm')
    return dshLlm
  }

  return async function complete(messages, { timeoutMs = defaultTimeoutMs, signal, route } = {}) {
    if (route === undefined) throw new Error('нет маршрута модели: в этой сессии ещё не было хода')
    const llm = ctx.llm
    if (llm === null || typeof llm?.prepareCall !== 'function') throw new Error('служба модели харнесса недоступна')

    const { BlockAssembler, createAssistantMessage, createUserMessage, isHarnessError } = await load()
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const turns = messages
      .filter((message) => message.role !== 'system')
      .map((message) =>
        message.role === 'user'
          ? createUserMessage({
              content: [{ type: 'text', text: message.content }],
              source: { kind: 'plugin', plugin: 'dsh-engram-memory' }
            })
          : createAssistantMessage({
              content: [{ type: 'text', text: message.content }],
              source: { provider: route.provider, model: route.model }
            })
      )

    const deadline = linkedSignal(signal, timeoutMs)
    try {
      const base = { provider: route.provider, model: route.model, maxTokens: 2000 }
      let prepared
      try {
        // Рассуждения выключены, когда адаптер это умеет: иначе они съедают
        // предел вывода, и структурного ответа (JSON) не остаётся вовсе.
        const info = await llm.resolveModelInfo?.(route.provider, route.model, deadline.signal)
        const supportsOff = info?.reasoning?.efforts?.some((effort) => effort.id === NO_REASONING_EFFORT) === true
        prepared = await llm.prepareCall(supportsOff ? { ...base, reasoningEffort: NO_REASONING_EFFORT } : base, deadline.signal)
      } catch (error) {
        if (isHarnessError?.(error) === true && error.code === UNSUPPORTED_REASONING_EFFORT) {
          prepared = await llm.prepareCall(base, deadline.signal)
        } else {
          throw error
        }
      }

      const request = {
        ...(prepared.config ?? base),
        messages: turns,
        ...(system === '' ? {} : { system }),
        signal: deadline.signal
      }
      const assembler = new BlockAssembler()
      for await (const chunk of prepared.stream(request)) {
        assembler.push(chunk)
      }
      if (assembler.finish?.kind !== 'stop') throw finishError(assembler.finish)
      const blocks = assembler.blocks()
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text.trim() === '') throw new Error('модель вернула пустой ответ')
      return { text, model: route.model, usage: mapUsage(assembler.usage) }
    } catch (error) {
      log(`вызов модели не удался: ${error?.message ?? error}`)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      deadline.dispose()
    }
  }
}
