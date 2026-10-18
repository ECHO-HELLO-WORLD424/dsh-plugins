import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyOpenRouterRouting,
  buildOpenRouterRouting,
  createModelRoutingPatcher,
  isOpenRouterModel,
  normalizeProviderName,
  OPENROUTER_PROVIDER_ID,
  resolveAdapterModel,
  stripOpenRouterRoutingFromRuntime,
} from '../lib/routing.js'

test('the catalog route this plugin shapes is openrouter', () => {
  assert.equal(OPENROUTER_PROVIDER_ID, 'openrouter')
})

test('provider names are trimmed and anything non-string is unset', () => {
  assert.equal(normalizeProviderName('  DeepInfra  '), 'DeepInfra')
  assert.equal(normalizeProviderName(''), '')
  assert.equal(normalizeProviderName('   '), '')
  assert.equal(normalizeProviderName(undefined), '')
  assert.equal(normalizeProviderName(null), '')
  assert.equal(normalizeProviderName(42), '')
  assert.equal(normalizeProviderName({ name: 'DeepInfra' }), '')
})

test('the default preference uses order with fallbacks enabled', () => {
  assert.deepEqual(buildOpenRouterRouting('DeepInfra'), {
    order: ['DeepInfra'],
    allow_fallbacks: true,
  })
  assert.deepEqual(buildOpenRouterRouting('  DeepInfra  ', true), {
    order: ['DeepInfra'],
    allow_fallbacks: true,
  })
})

test('disabling fallbacks pins the provider with only', () => {
  assert.deepEqual(buildOpenRouterRouting('DeepInfra', false), {
    only: ['DeepInfra'],
    allow_fallbacks: false,
  })
})

test('an unset provider builds no routing object', () => {
  assert.equal(buildOpenRouterRouting(''), undefined)
  assert.equal(buildOpenRouterRouting('   '), undefined)
  assert.equal(buildOpenRouterRouting(undefined), undefined)
  assert.equal(buildOpenRouterRouting({}), undefined)
})

test('applying routing preserves existing compat fields and restores the previous object', () => {
  const previousCompat = { thinkingFormat: 'openrouter' }
  const model = { id: 'deepseek/deepseek-v4.1-flash', compat: previousCompat }
  const routing = buildOpenRouterRouting('DeepInfra')

  const installed = applyOpenRouterRouting([model], routing)

  assert.equal(installed.applied, 1)
  assert.equal(installed.skipped, 0)
  assert.notEqual(model.compat, previousCompat)
  assert.deepEqual(model.compat, {
    thinkingFormat: 'openrouter',
    openRouterRouting: routing,
  })
  assert.equal(previousCompat.openRouterRouting, undefined, 'the previous object is not mutated')

  installed.dispose()

  assert.equal(model.compat, previousCompat)
})

test('a model without compat receives one and is restored to absent', () => {
  const model = { id: 'deepseek/deepseek-v4-flash' }
  const installed = applyOpenRouterRouting([model], { order: ['Together'], allow_fallbacks: true })

  assert.deepEqual(model.compat, { openRouterRouting: { order: ['Together'], allow_fallbacks: true } })

  installed.dispose()

  assert.equal(model.compat, undefined)
  assert.equal(Object.hasOwn(model, 'compat'), true)
})

test('disposal leaves a later writer\'s compat object alone', () => {
  const model = { id: 'model', compat: { thinkingFormat: 'openrouter' } }
  const installed = applyOpenRouterRouting([model], { order: ['DeepInfra'], allow_fallbacks: true })

  const later = { thinkingFormat: 'openrouter', marker: 'later' }
  model.compat = later

  installed.dispose()

  assert.equal(model.compat, later)
})

test('frozen models are skipped instead of failing the whole patch', () => {
  const frozen = Object.freeze({ id: 'frozen', compat: {} })
  const mutable = { id: 'mutable' }

  const installed = applyOpenRouterRouting([frozen, mutable], { order: ['DeepInfra'], allow_fallbacks: true })

  assert.equal(installed.applied, 1)
  assert.equal(installed.skipped, 1)
  assert.equal(frozen.compat.openRouterRouting, undefined)
  assert.deepEqual(mutable.compat.openRouterRouting, { order: ['DeepInfra'], allow_fallbacks: true })
})

test('invalid model entries are skipped', () => {
  const installed = applyOpenRouterRouting([null, undefined, 42, 'model'], { order: ['x'] })
  assert.equal(installed.applied, 0)
  assert.equal(installed.skipped, 4)
  installed.dispose()
})

test('disposing twice is harmless', () => {
  const model = { id: 'model' }
  const installed = applyOpenRouterRouting([model], { order: ['DeepInfra'] })
  assert.equal(installed.applied, 1)

  installed.dispose()
  installed.dispose()

  assert.equal(model.compat, undefined)
})

test('OpenRouter models are recognized by route or endpoint', () => {
  assert.equal(isOpenRouterModel({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), true)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'https://openrouter.ai/api/v1' }), true)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'https://openrouter.ai' }), true)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'https://eu.openrouter.ai/api/v1' }), true)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'https://openrouter.ai.evil.example/v1' }), false)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'https://example.com/openrouter.ai' }), false)
  assert.equal(isOpenRouterModel({ provider: 'deepseek-official' }), false)
  assert.equal(isOpenRouterModel({ provider: 'my-router', baseUrl: 'not a url' }), false)
  assert.equal(isOpenRouterModel(null), false)
})

test('resolveAdapterModel reads the live pi-ai model object from an adapter snapshot', () => {
  const model = { id: 'deepseek/deepseek-v4.1-flash', api: 'openai-completions', compat: { thinkingFormat: 'openrouter' } }
  const runtime = {
    adapters: new Map([
      ['openrouter', {
        adapter: {
          current: () => ({ models: { getModel: (provider, id) => provider === 'openrouter' && id === model.id ? model : undefined } }),
        },
      }],
    ]),
  }

  assert.equal(resolveAdapterModel(runtime, 'openrouter', model.id), model)
  assert.equal(resolveAdapterModel(runtime, 'openrouter', 'other/model'), undefined)
  assert.equal(resolveAdapterModel(runtime, 'missing', model.id), undefined)
})

test('resolveAdapterModel tolerates runtimes and adapters without the pi-ai snapshot shape', () => {
  assert.equal(resolveAdapterModel(undefined, 'openrouter', 'm'), undefined)
  assert.equal(resolveAdapterModel({}, 'openrouter', 'm'), undefined)
  assert.equal(resolveAdapterModel({ adapters: new Map() }, 'openrouter', 'm'), undefined)
  assert.equal(resolveAdapterModel({ adapters: new Map([['openrouter', { adapter: {} }]]) }, 'openrouter', 'm'), undefined)
  assert.equal(resolveAdapterModel({ adapters: new Map([['openrouter', { adapter: { current: () => ({}) } }]]) }, 'openrouter', 'm'), undefined)
  assert.equal(
    resolveAdapterModel({
      adapters: new Map([['openrouter', { adapter: { current: () => { throw new Error('boom') } } }]]),
    }, 'openrouter', 'm'),
    undefined,
  )
})

test('the model patcher shapes an already-resolved model and restores it on disposal', () => {
  const catalogCompat = { thinkingFormat: 'openrouter' }
  const model = { id: 'deepseek/deepseek-v4.1-flash', compat: catalogCompat }
  const routing = { order: ['DeepInfra'], allow_fallbacks: true }
  const patcher = createModelRoutingPatcher(routing)

  assert.equal(patcher.patch(model), true)
  assert.deepEqual(model.compat, { thinkingFormat: 'openrouter', openRouterRouting: routing })
  assert.equal(patcher.size, 1)
  assert.equal(patcher.patch(model), false, 'an already-shaped model is not patched twice')
  assert.equal(patcher.size, 1)

  patcher.dispose()

  assert.equal(model.compat, catalogCompat)
  assert.equal(patcher.size, 0)
})

test('the model patcher skips frozen models and an already-routed model', () => {
  const routing = { order: ['DeepInfra'], allow_fallbacks: true }
  const patcher = createModelRoutingPatcher(routing)
  const frozen = Object.freeze({ compat: {} })

  assert.equal(patcher.patch(frozen), false)
  assert.equal(patcher.patch(null), false)
  assert.equal(patcher.size, 0)
})

test('a model born with this generation\'s routing is cleaned on disposal', () => {
  const routing = { order: ['DeepInfra'], allow_fallbacks: true }
  const model = {
    id: 'deepseek/deepseek-v4.1-flash',
    compat: { thinkingFormat: 'openrouter', openRouterRouting: routing },
  }
  const patcher = createModelRoutingPatcher(routing)

  assert.equal(patcher.patch(model), false, 'the model already carries the preference')
  assert.equal(patcher.size, 1, 'the model is tracked for cleanup anyway')
  assert.equal(model.compat.openRouterRouting, routing)

  patcher.dispose()

  assert.deepEqual(model.compat, { thinkingFormat: 'openrouter' })
  assert.equal(patcher.size, 0)
})

test('the model patcher leaves a later writer alone and survives double disposal', () => {
  const model = { id: 'model' }
  const routing = { order: ['DeepInfra'], allow_fallbacks: true }
  const patcher = createModelRoutingPatcher(routing)

  patcher.patch(model)
  const later = { marker: 'later' }
  model.compat = later

  patcher.dispose()
  patcher.dispose()

  assert.equal(model.compat, later)
})

test('the runtime sweep removes this generation\'s routing from live snapshots', () => {
  const routing = { order: ['DeepInfra'], allow_fallbacks: true }
  const otherRouting = { order: ['Together'], allow_fallbacks: true }
  const shaped = { id: 'shaped', compat: { thinkingFormat: 'openrouter', openRouterRouting: routing } }
  const foreign = { id: 'foreign', compat: { openRouterRouting: otherRouting } }
  const plain = { id: 'plain', compat: { thinkingFormat: 'openrouter' } }
  const runtime = {
    adapters: new Map([
      ['openrouter', {
        adapter: {
          current: () => ({
            models: {
              getProviders: () => [
                { getModels: () => [shaped, foreign, plain] },
                { getModels: () => { throw new Error('broken provider') } },
              ],
            },
          }),
        },
      }],
      ['no-snapshot', { adapter: {} }],
    ]),
  }

  assert.equal(stripOpenRouterRoutingFromRuntime(runtime, routing), 1)
  assert.deepEqual(shaped.compat, { thinkingFormat: 'openrouter' })
  assert.equal(foreign.compat.openRouterRouting, otherRouting)
  assert.deepEqual(plain.compat, { thinkingFormat: 'openrouter' })

  assert.equal(stripOpenRouterRoutingFromRuntime(undefined, routing), 0)
  assert.equal(stripOpenRouterRoutingFromRuntime({ adapters: new Map() }, routing), 0)
})

test('the installed pi-ai catalog accepts the patch when available', async (t) => {
  let catalog
  try {
    catalog = await import('@earendil-works/pi-ai/providers/all')
  } catch {
    t.skip('@earendil-works/pi-ai is not resolvable from this test environment')
    return
  }

  const models = catalog.getBuiltinModels(OPENROUTER_PROVIDER_ID)
  assert.ok(models.length > 0, 'the installed pi-ai catalog ships OpenRouter models')

  const routing = buildOpenRouterRouting('DeepInfra')
  const installed = applyOpenRouterRouting(models, routing)
  assert.equal(installed.applied, models.length)
  for (const model of models) {
    assert.deepEqual(model.compat?.openRouterRouting, routing)
  }

  installed.dispose()
  for (const model of models) {
    assert.notEqual(model.compat?.openRouterRouting, routing, 'disposal restores the catalog')
  }
})
