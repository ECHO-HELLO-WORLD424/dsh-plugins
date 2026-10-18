/**
 * OpenRouter provider-routing preferences.
 *
 * OpenRouter reads an optional top-level `provider` object from each request
 * body. `order` names the upstream providers to try first while
 * `allow_fallbacks` lets OpenRouter continue with its own default routing when
 * none of them can serve the request — which is exactly the "prefer this
 * provider, but never fail because of it" behavior this plugin exposes.
 *
 * @module dsh-openrouter-provider-routing/routing
 */

/** pi-ai catalog id of the provider this plugin shapes. */
export const OPENROUTER_PROVIDER_ID = 'openrouter'

/**
 * Read a configured provider name.
 *
 * OpenRouter provider names are free-form operator input here: this plugin
 * does not fetch or validate the provider list, so anything but a non-empty
 * string after trimming is "not configured".
 *
 * @param {unknown} value - raw configuration value.
 * @returns {string} the trimmed provider name, or an empty string.
 */
export function normalizeProviderName(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the request-body `provider` object for one configured provider.
 *
 * With fallbacks enabled (the default), the provider is an `order` preference:
 * OpenRouter tries it first and then continues with its normal routing policy
 * when the provider is unavailable or does not serve the requested model. With
 * fallbacks disabled, `only` + `allow_fallbacks: false` pins the request to
 * that provider and lets OpenRouter fail instead of substituting another one.
 *
 * @param {unknown} provider - configured provider name or slug.
 * @param {boolean} [allowFallbacks] - whether OpenRouter may substitute another provider.
 * @returns {Record<string, unknown> | undefined} the `provider` object, or
 *   `undefined` when no provider is configured.
 */
export function buildOpenRouterRouting(provider, allowFallbacks = true) {
  const name = normalizeProviderName(provider)
  if (name === '') return undefined
  if (allowFallbacks === false) return { only: [name], allow_fallbacks: false }
  return { order: [name], allow_fallbacks: true }
}

/**
 * Attach routing preferences to every mutable model in a pi-ai catalog.
 *
 * Each model receives a fresh `compat` object so a config change can be
 * reverted by identity: an in-flight request that already resolved its model
 * never starts sending a different provider preference mid-stream. Models the
 * host froze are skipped rather than failing the whole patch.
 *
 * @param {readonly object[]} models - pi-ai model descriptors (normally the
 *   installed OpenRouter catalog).
 * @param {Record<string, unknown>} routing - request-body `provider` object.
 * @returns {{ applied: number, skipped: number, dispose(): void }} how many
 *   models were patched and the inverse operation.
 */
export function applyOpenRouterRouting(models, routing) {
  /** @type {Array<() => void>} */
  const restorations = []
  let applied = 0
  let skipped = 0

  for (const model of models) {
    if (typeof model !== 'object' || model === null) {
      skipped += 1
      continue
    }
    if (Object.isFrozen(model) || !Object.isExtensible(model)) {
      skipped += 1
      continue
    }
    const previous = model.compat
    const base = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {}
    const next = { ...base, openRouterRouting: routing }
    try {
      model.compat = next
    } catch {
      skipped += 1
      continue
    }
    applied += 1
    restorations.push(() => {
      // Leave a later writer's value alone: only undo our own object.
      if (model.compat !== next) return
      try {
        model.compat = previous
      } catch {
        // A model frozen after our patch keeps the routing instead of
        // breaking plugin disposal.
      }
    })
  }

  return {
    applied,
    skipped,
    dispose() {
      for (const restore of restorations.reverse()) restore()
      restorations.length = 0
    },
  }
}

/** A non-null, non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one resolved model speaks to OpenRouter.
 *
 * The canonical route is pi-ai's `openrouter` provider, but a hand-declared
 * route may point at `https://openrouter.ai/api/v1` under another key. Both
 * count, so a custom alias receives the same provider preference.
 *
 * @param {unknown} model - resolved pi-ai model object.
 * @returns {boolean} whether OpenRouter reads this model's requests.
 */
export function isOpenRouterModel(model) {
  if (!isRecord(model)) return false
  if (model.provider === OPENROUTER_PROVIDER_ID) return true
  if (typeof model.baseUrl !== 'string' || model.baseUrl.length === 0) return false
  try {
    const host = new URL(model.baseUrl).hostname.toLowerCase()
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/**
 * Resolve the concrete pi-ai model object an LLM adapter will stream.
 *
 * DSH's pi-ai adapter builds each request model from the installed catalog at
 * activation time, then hands that same object to pi-ai on every stream. A
 * catalog patched after activation therefore does not reach the already-built
 * model, so the stream hook looks the object up through the adapter's live
 * snapshot (`PiAiAdapter.current()`) and shapes it in place.
 *
 * The lookup is defensive: an adapter without the pi-ai snapshot shape, a
 * provider it does not own, or an unknown model simply yields `undefined` and
 * the request proceeds untouched.
 *
 * @param {unknown} runtime - the `llm` service (an `LlmRuntime`).
 * @param {string} provider - provider route key.
 * @param {string} modelId - model id.
 * @returns {object | undefined} the model object pi-ai will receive, when resolvable.
 */
export function resolveAdapterModel(runtime, provider, modelId) {
  let adapter
  try {
    adapter = runtime?.adapters?.get?.(provider)?.adapter
  } catch {
    return undefined
  }
  if (adapter === undefined || adapter === null || typeof adapter.current !== 'function') return undefined

  let snapshot
  try {
    snapshot = adapter.current()
  } catch {
    return undefined
  }

  const models = snapshot?.models
  if (models === undefined || models === null || typeof models.getModel !== 'function') return undefined

  try {
    const model = models.getModel(provider, modelId)
    return isRecord(model) ? model : undefined
  } catch {
    return undefined
  }
}

/**
 * Shape individual model objects as requests reach the adapter.
 *
 * The catalog patch covers models resolved after plugin activation; this
 * patcher covers the ones an adapter already built (or will build from a
 * provider it constructed itself) by mutating the exact object pi-ai streams.
 * A model that was born with this generation's preference is tracked too, so
 * disabling the plugin removes the preference from the adapter's live snapshot
 * instead of leaving it behind.
 *
 * @param {Record<string, unknown>} routing - request-body `provider` object.
 * @returns {{ patch(model: unknown): boolean, dispose(): void, readonly size: number }} patcher.
 */
export function createModelRoutingPatcher(routing) {
  /** @type {Map<object, { previous: unknown, next: object, born: boolean }>} */
  const patched = new Map()

  return {
    /**
     * Attach routing to one model, unless it already carries it.
     * @param {unknown} model - candidate pi-ai model object.
     * @returns {boolean} whether this call changed the model.
     */
    patch(model) {
      if (!isRecord(model)) return false

      if (model.compat?.openRouterRouting === routing) {
        // A model resolved from the already-patched catalog carries the
        // preference without this patcher writing it. Track it so disposal can
        // strip the field: that model's compat is a copy, not the catalog
        // entry the catalog patch restores.
        if (!patched.has(model)) patched.set(model, { previous: model.compat, next: model.compat, born: true })
        return false
      }

      if (Object.isFrozen(model) || !Object.isExtensible(model)) return false

      const previous = model.compat
      const next = { ...(isRecord(previous) ? previous : {}), openRouterRouting: routing }
      try {
        model.compat = next
      } catch {
        return false
      }
      patched.set(model, { previous, next, born: false })
      return true
    },

    dispose() {
      for (const [model, { previous, next, born }] of patched) {
        if (model.compat !== next) continue
        if (born) {
          // The value was not ours: remove only the field this plugin added.
          if (!isRecord(previous)) continue
          const cleaned = { ...previous }
          delete cleaned.openRouterRouting
          try {
            model.compat = cleaned
          } catch {
            // A model frozen after our patch keeps the routing instead of
            // breaking plugin disposal.
          }
          continue
        }
        try {
          model.compat = previous
        } catch {
          // A model frozen after our patch keeps the routing instead of
          // breaking plugin disposal.
        }
      }
      patched.clear()
    },

    get size() {
      return patched.size
    },
  }
}

/**
 * Remove this generation's routing from every live adapter snapshot.
 *
 * A model resolved while the catalog was already shaped is born with the
 * preference and may never pass through {@link createModelRoutingPatcher} (no
 * request since activation). Disabling the plugin must still take effect, so
 * disposal walks the live pi-ai snapshots once and strips only the routing
 * object this generation installed.
 *
 * @param {unknown} runtime - the `llm` service (an `LlmRuntime`).
 * @param {Record<string, unknown>} routing - the routing object to remove.
 * @returns {number} how many model objects were cleaned.
 */
export function stripOpenRouterRoutingFromRuntime(runtime, routing) {
  let adapters
  try {
    adapters = runtime?.adapters
  } catch {
    return 0
  }
  if (!(adapters instanceof Map)) return 0

  let cleaned = 0
  for (const registration of adapters.values()) {
    const adapter = registration?.adapter
    if (adapter === undefined || adapter === null || typeof adapter.current !== 'function') continue

    let snapshot
    try {
      snapshot = adapter.current()
    } catch {
      continue
    }
    const models = snapshot?.models
    if (models === undefined || models === null || typeof models.getProviders !== 'function') continue

    let providers
    try {
      providers = models.getProviders()
    } catch {
      continue
    }
    if (!Array.isArray(providers)) continue

    for (const provider of providers) {
      if (provider === undefined || provider === null || typeof provider.getModels !== 'function') continue
      let list
      try {
        list = provider.getModels()
      } catch {
        continue
      }
      if (!Array.isArray(list)) continue
      for (const model of list) {
        if (!isRecord(model) || model.compat?.openRouterRouting !== routing) continue
        const next = { ...model.compat }
        delete next.openRouterRouting
        try {
          model.compat = next
          cleaned += 1
        } catch {
          // A frozen model keeps the routing; there is nothing safe to do.
        }
      }
    }
  }
  return cleaned
}
