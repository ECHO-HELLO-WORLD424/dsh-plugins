import assert from 'node:assert/strict'
import test from 'node:test'

import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

import { apply, Config } from '../lib/index.js'
import { OPENROUTER_PROVIDER_ID } from '../lib/routing.js'

const MODEL = 'deepseek/deepseek-v4.1-flash'

/** A minimal Cordis context recording listeners, effects, and logs. */
function createContext(runtime) {
  const listeners = new Map()
  const cleanups = []
  const logs = []
  const logger =
    (level) =>
    (...args) => {
      logs.push([level, ...args])
    }
  const ctx = {
    logger: { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(factory, label) {
      cleanups.push({ label, dispose: factory() })
      return () => {}
    },
    get(name) {
      return name === 'llm' ? runtime : undefined
    },
  }
  return { ctx, listeners, cleanups, logs }
}

/** A fake pi-ai adapter snapshot holding the given models, keyed by route. */
function createRuntime(...models) {
  const routes = new Map()
  for (const model of models) {
    routes.set(model.provider, {
      adapter: {
        current: () => ({
          models: {
            getModel: (provider, id) => {
              const found = models.find((candidate) => candidate.provider === provider && candidate.id === id)
              return found
            },
          },
        }),
      },
    })
  }
  return { adapters: routes }
}

/** Fire the `llm/stream` waterfall listener once. */
function shapeRequest(listeners, provider, model) {
  const handler = listeners.get('llm/stream')
  assert.equal(typeof handler, 'function', 'the plugin subscribes to llm/stream')
  let nextCalled = false
  const result = handler({ provider, model }, () => {
    nextCalled = true
    return 'stream'
  })
  assert.equal(result, 'stream')
  assert.equal(nextCalled, true)
}

/** Dispose every effect a fake context recorded. */
function disposeAll(cleanups) {
  for (const cleanup of cleanups) cleanup.dispose()
}

test('config defaults keep the plugin inert', () => {
  const config = new Config({})
  assert.equal(config.provider, '')
  assert.equal(config.model, '')
  assert.equal(config.allowFallbacks, true)
})

test('apply shapes only the configured model and config changes replace the preference', () => {
  const model = {
    id: MODEL,
    provider: 'openrouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    compat: { thinkingFormat: 'openrouter' },
  }
  const originalCompat = model.compat
  const runtime = createRuntime(model)

  const first = createContext(runtime)
  apply(first.ctx, new Config({ provider: 'DeepInfra', model: MODEL }))
  shapeRequest(first.listeners, 'openrouter', model.id)

  assert.deepEqual(model.compat, {
    thinkingFormat: 'openrouter',
    openRouterRouting: { order: ['DeepInfra'], allow_fallbacks: true },
  })
  assert.equal(first.logs.filter(([level]) => level === 'info').length, 1)

  // A request for another model is not shaped, even through the same route.
  const other = { id: 'other/model', provider: 'openrouter', api: 'openai-completions', compat: {} }
  const otherRuntime = createRuntime(model, other)
  const otherContext = createContext(otherRuntime)
  apply(otherContext.ctx, new Config({ provider: 'DeepInfra', model: MODEL }))
  shapeRequest(otherContext.listeners, 'openrouter', other.id)
  assert.equal(other.compat.openRouterRouting, undefined)
  disposeAll(otherContext.cleanups)

  disposeAll(first.cleanups)
  assert.equal(model.compat, originalCompat, 'disposal restores the catalog-provided compat')

  const second = createContext(runtime)
  apply(second.ctx, new Config({ provider: 'Together', model: MODEL, allowFallbacks: false }))
  shapeRequest(second.listeners, 'openrouter', model.id)

  assert.deepEqual(model.compat, {
    thinkingFormat: 'openrouter',
    openRouterRouting: { only: ['Together'], allow_fallbacks: false },
  })
  disposeAll(second.cleanups)
  assert.equal(model.compat, originalCompat)
})

test('the catalog is shaped only for the configured model', () => {
  const models = getBuiltinModels(OPENROUTER_PROVIDER_ID)
  assert.ok(models.length >= 2, 'the installed pi-ai catalog ships OpenRouter models')
  const target = models[0]
  const other = models[1]
  const originalTarget = target.compat
  const originalOther = other.compat
  const { ctx, cleanups } = createContext(undefined)

  apply(ctx, new Config({ provider: 'deepinfra', model: target.id }))

  assert.deepEqual(target.compat.openRouterRouting, { order: ['deepinfra'], allow_fallbacks: true })
  assert.equal(other.compat?.openRouterRouting, undefined, 'a different catalog model stays untouched')

  disposeAll(cleanups)

  assert.equal(target.compat, originalTarget)
  assert.equal(other.compat, originalOther)
})

test('a catalog-missing model id is still steered per stream', () => {
  const customId = 'custom/not-in-catalog'
  const customModel = {
    id: customId,
    provider: 'openrouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    compat: {},
  }
  const runtime = createRuntime(customModel)
  const { ctx, listeners, cleanups, logs } = createContext(runtime)

  apply(ctx, new Config({ provider: 'deepinfra', model: customId }))
  shapeRequest(listeners, 'openrouter', customId)

  assert.deepEqual(customModel.compat.openRouterRouting, { order: ['deepinfra'], allow_fallbacks: true })
  assert.equal(logs.filter(([level]) => level === 'info').length, 1)
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('not in the installed catalog')))

  disposeAll(cleanups)
})

test('an empty provider or model installs no listener and changes nothing', () => {
  for (const config of [
    { provider: '   ' },
    { model: MODEL },
    { provider: '   ', model: MODEL },
    { provider: 'deepinfra', model: '   ' },
  ]) {
    const model = { id: MODEL, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
    const runtime = createRuntime(model)
    const { ctx, listeners, cleanups } = createContext(runtime)

    apply(ctx, new Config(config))

    assert.equal(listeners.has('llm/stream'), false)
    assert.equal(cleanups.length, 0)
    assert.equal(model.compat, undefined)
  }
})

test('non-OpenRouter requests pass through untouched', () => {
  const model = { id: 'm', provider: 'openai', baseUrl: 'https://api.openai.com/v1', compat: { supportsStore: true } }
  const originalCompat = model.compat
  const runtime = createRuntime(model)
  const { ctx, listeners, cleanups } = createContext(runtime)

  apply(ctx, new Config({ provider: 'DeepInfra', model: 'm' }))
  shapeRequest(listeners, 'openai', model.id)

  assert.equal(model.compat, originalCompat)

  disposeAll(cleanups)
})

test('a request for a route without the pi-ai snapshot shape passes through', () => {
  const { ctx, listeners, cleanups } = createContext(undefined)
  apply(ctx, new Config({ provider: 'DeepInfra', model: MODEL }))

  shapeRequest(listeners, 'openrouter', MODEL)

  disposeAll(cleanups)
})
