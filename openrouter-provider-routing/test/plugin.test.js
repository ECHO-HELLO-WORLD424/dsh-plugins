import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config } from '../lib/index.js'

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

/** A fake pi-ai adapter snapshot holding one OpenRouter model. */
function createRuntime(model) {
  return {
    adapters: new Map([
      [
        'openrouter',
        {
          adapter: {
            current: () => ({
              models: {
                getModel: (provider, id) => (provider === 'openrouter' && id === model.id ? model : undefined),
              },
            }),
          },
        },
      ],
    ]),
  }
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

test('config defaults keep the plugin inert', () => {
  const config = new Config({})
  assert.equal(config.provider, '')
  assert.equal(config.allowFallbacks, true)
})

test('apply shapes the live request model and config changes replace the preference', () => {
  const model = {
    id: 'deepseek/deepseek-v4.1-flash',
    provider: 'openrouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    compat: { thinkingFormat: 'openrouter' },
  }
  const originalCompat = model.compat
  const runtime = createRuntime(model)

  const first = createContext(runtime)
  apply(first.ctx, new Config({ provider: 'DeepInfra' }))
  shapeRequest(first.listeners, 'openrouter', model.id)

  assert.deepEqual(model.compat, {
    thinkingFormat: 'openrouter',
    openRouterRouting: { order: ['DeepInfra'], allow_fallbacks: true },
  })
  assert.equal(first.logs.filter(([level]) => level === 'info').length, 1)

  for (const cleanup of first.cleanups) cleanup.dispose()
  assert.equal(model.compat, originalCompat, 'disposal restores the catalog-provided compat')

  const second = createContext(runtime)
  apply(second.ctx, new Config({ provider: 'Together', allowFallbacks: false }))
  shapeRequest(second.listeners, 'openrouter', model.id)

  assert.deepEqual(model.compat, {
    thinkingFormat: 'openrouter',
    openRouterRouting: { only: ['Together'], allow_fallbacks: false },
  })
  for (const cleanup of second.cleanups) cleanup.dispose()
  assert.equal(model.compat, originalCompat)
})

test('an empty provider installs no listener and changes nothing', () => {
  const model = { id: 'm', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
  const runtime = createRuntime(model)
  const { ctx, listeners, cleanups } = createContext(runtime)

  apply(ctx, new Config({ provider: '   ' }))

  assert.equal(listeners.has('llm/stream'), false)
  assert.equal(cleanups.length, 0)
  assert.equal(model.compat, undefined)
})

test('non-OpenRouter requests pass through untouched', () => {
  const model = { id: 'm', provider: 'openai', baseUrl: 'https://api.openai.com/v1', compat: { supportsStore: true } }
  const originalCompat = model.compat
  const runtime = createRuntime(model)
  const { ctx, listeners, cleanups } = createContext(runtime)

  apply(ctx, new Config({ provider: 'DeepInfra' }))
  const handler = listeners.get('llm/stream')
  let nextCalled = false
  handler({ provider: 'openai', model: model.id }, () => {
    nextCalled = true
    return 'stream'
  })

  assert.equal(nextCalled, true)
  assert.equal(model.compat, originalCompat)

  for (const cleanup of cleanups) cleanup.dispose()
})

test('a request for a route without the pi-ai snapshot shape passes through', () => {
  const { ctx, listeners, cleanups } = createContext(undefined)
  apply(ctx, new Config({ provider: 'DeepInfra' }))

  const handler = listeners.get('llm/stream')
  let nextCalled = false
  handler({ provider: 'openrouter', model: 'm' }, () => {
    nextCalled = true
    return 'stream'
  })

  assert.equal(nextCalled, true)
  for (const cleanup of cleanups) cleanup.dispose()
})
