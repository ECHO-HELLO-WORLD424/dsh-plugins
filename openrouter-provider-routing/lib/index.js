/**
 * Prefer an OpenRouter upstream provider for one configured model, without
 * losing OpenRouter's fallback routing.
 *
 * pi-ai turns `model.compat.openRouterRouting` into the request-body `provider`
 * object that OpenRouter reads. Two layers keep that field on the one model DSH
 * actually streams:
 *
 * 1. The configured model's entry in the installed OpenRouter catalog is shaped
 *    when this plugin activates, so model sets resolved afterwards are born
 *    with the preference.
 * 2. An `llm/stream` listener shapes the concrete model object an adapter built
 *    before activation — DSH's pi-ai adapter resolves its catalog at plugin
 *    activation, so a later catalog patch alone would miss it.
 *
 * Requests for every other model are left on OpenRouter's own routing. That is
 * deliberate: an upstream provider that does not serve some other model must
 * never be asked to serve it just because this model prefers it.
 *
 * No proxy and no second adapter are involved, and credentials stay with the
 * existing OpenRouter route.
 *
 * @module dsh-openrouter-provider-routing
 */

import z from '@deepseek-ai/schemastery'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  OPENROUTER_PROVIDER_ID,
  applyOpenRouterRouting,
  buildOpenRouterRouting,
  createModelRoutingPatcher,
  isOpenRouterModel,
  normalizeModelId,
  normalizeProviderName,
  resolveAdapterModel,
  stripOpenRouterRoutingFromRuntime,
} from './routing.js'

/** Cordis plugin name. */
export const name = 'openrouter-provider-routing'

/**
 * Validated configuration.
 *
 * Both `provider` and `model` must be set for the plugin to do anything, which
 * is what lets the bundle insert an inert row before the user has chosen a
 * provider and model.
 */
export const Config = z.object({
  provider: z
    .string()
    .default('')
    .description('OpenRouter provider slug to prefer, for example "deepinfra". Leave empty to keep OpenRouter\'s own routing.'),
  model: z
    .string()
    .default('')
    .description('Exact OpenRouter model id to shape, for example "deepseek/deepseek-v4.1-flash". Only requests for this model receive the provider preference. Leave empty to keep OpenRouter\'s own routing.'),
  allowFallbacks: z
    .boolean()
    .default(true)
    .description('When true, OpenRouter falls back to its default routing if the preferred provider cannot serve the request. When false, only that provider may serve it.'),
})

/**
 * Apply the configured provider preference to one model.
 *
 * Both layers live for the lifetime of this plugin fiber: a configuration
 * change or disable restores the touched catalog entry and request model before
 * the next generation installs its own preference.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ provider?: string, model?: string, allowFallbacks?: boolean }} config - validated configuration.
 */
export function apply(ctx, config) {
  const provider = normalizeProviderName(config?.provider)
  const modelId = normalizeModelId(config?.model)

  if (provider === '' || modelId === '') {
    if (provider !== '' || modelId !== '') {
      ctx.logger.warn(
        'openrouter-provider-routing: both "provider" and "model" are required; leaving OpenRouter routing unchanged',
      )
    } else {
      ctx.logger.debug('openrouter-provider-routing: no provider/model configured; leaving OpenRouter routing unchanged')
    }
    return
  }

  const allowFallbacks = config?.allowFallbacks !== false
  const routing = buildOpenRouterRouting(provider, allowFallbacks)
  if (routing === undefined) return

  const catalog = installCatalogRouting(ctx, routing, modelId)
  const patcher = createModelRoutingPatcher(routing)
  let warnedUnpatchable = false
  let warnedUnresolvable = false
  let warnedWireProtocol = false

  ctx.on('llm/stream', (options, next) => {
    try {
      // Every other model keeps OpenRouter's default routing, even when its
      // request happens to pass the same provider route.
      if (options.model === modelId) {
        const model = resolveAdapterModel(ctx.get('llm'), options.provider, options.model)
        if (model === undefined) {
          if (options.provider === OPENROUTER_PROVIDER_ID && !warnedUnresolvable) {
            warnedUnresolvable = true
            ctx.logger.warn(
              `openrouter-provider-routing: cannot resolve the live model for provider route "openrouter"; requests for "${modelId}" use OpenRouter's own routing`,
            )
          }
        } else if (isOpenRouterModel(model)) {
          if (model.api !== 'openai-completions' && !warnedWireProtocol) {
            warnedWireProtocol = true
            ctx.logger.warn(
              `openrouter-provider-routing: OpenRouter model "${options.model}" uses the "${String(model.api)}" protocol; OpenRouter reads provider routing only on openai-completions requests`,
            )
          }
          patcher.patch(model)
          if (model.compat?.openRouterRouting !== routing && !warnedUnpatchable) {
            warnedUnpatchable = true
            ctx.logger.warn(
              `openrouter-provider-routing: provider "${provider}" could not be attached to the live OpenRouter model "${modelId}"; this request uses OpenRouter's own routing`,
            )
          }
        }
      }
    } catch (error) {
      ctx.logger.debug(`openrouter-provider-routing: request shaping failed: ${String(error)}`)
    }
    return next()
  })

  ctx.effect(
    () => () => {
      patcher.dispose()
      try {
        stripOpenRouterRoutingFromRuntime(ctx.get('llm'), routing)
      } catch {
        // The LLM service may already be gone during application shutdown.
      }
      catalog?.dispose()
    },
    'openrouter-provider-routing',
  )

  const mode = allowFallbacks ? 'with OpenRouter fallback' : 'strictly, without fallbacks'
  if (catalog === undefined) {
    ctx.logger.warn(
      `openrouter-provider-routing: preferring OpenRouter provider "${provider}" for model "${modelId}" ${mode}; the installed catalog could not be shaped, so requests are steered per stream`,
    )
    return
  }
  if (catalog.missing) {
    ctx.logger.info(
      `openrouter-provider-routing: preferring OpenRouter provider "${provider}" for model "${modelId}" ${mode}; the model is not in the installed catalog, so requests are steered per stream`,
    )
    return
  }
  if (catalog.applied === 0) return
  ctx.logger.info(
    `openrouter-provider-routing: preferring OpenRouter provider "${provider}" for model "${modelId}" ${mode}`,
  )
}

/**
 * Shape the configured model's entry in the installed OpenRouter catalog,
 * tolerating an unavailable or unexpected pi-ai module.
 *
 * A model the catalog does not describe is not an error: it is either a custom
 * model id or a newer release, and the stream hook applies the preference to
 * the model object the adapter builds.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} routing - request-body `provider` object.
 * @param {string} modelId - exact model id to shape.
 * @returns {{ applied: number, skipped: number, missing: boolean, dispose(): void } | undefined} installed catalog patch.
 */
function installCatalogRouting(ctx, routing, modelId) {
  let models
  try {
    models = getBuiltinModels(OPENROUTER_PROVIDER_ID)
  } catch (error) {
    ctx.logger.warn(`openrouter-provider-routing: cannot read the installed OpenRouter catalog: ${String(error)}`)
    return undefined
  }
  if (!Array.isArray(models) || models.length === 0) {
    ctx.logger.warn('openrouter-provider-routing: the installed pi-ai catalog has no OpenRouter models to shape')
    return undefined
  }

  const matching = models.filter((model) => model?.id === modelId)
  if (matching.length === 0) return { applied: 0, skipped: 0, missing: true, dispose() {} }

  const installed = applyOpenRouterRouting(matching, routing)
  if (installed.applied === 0) {
    ctx.logger.warn(
      `openrouter-provider-routing: catalog model "${modelId}" is frozen or invalid, so the preference is applied per stream instead`,
    )
  }
  return { ...installed, missing: false }
}
