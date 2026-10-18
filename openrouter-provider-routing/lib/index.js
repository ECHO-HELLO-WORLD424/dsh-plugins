/**
 * Prefer an OpenRouter upstream provider without losing OpenRouter's fallback
 * routing.
 *
 * pi-ai turns `model.compat.openRouterRouting` into the request-body `provider`
 * object that OpenRouter reads. Two layers keep that field on the models DSH
 * actually streams:
 *
 * 1. The installed OpenRouter catalog is shaped when this plugin activates, so
 *    model sets resolved afterwards are born with the preference.
 * 2. An `llm/stream` listener shapes the concrete model object an adapter built
 *    before activation — DSH's pi-ai adapter resolves its catalog at plugin
 *    activation, so a later catalog patch alone would miss it.
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
  normalizeProviderName,
  resolveAdapterModel,
  stripOpenRouterRoutingFromRuntime,
} from './routing.js'

/** Cordis plugin name. */
export const name = 'openrouter-provider-routing'

/**
 * Validated configuration.
 *
 * An empty `provider` leaves the plugin inert, which is what lets the bundle
 * insert its row before the user has chosen a provider.
 */
export const Config = z.object({
  provider: z
    .string()
    .default('')
    .description('OpenRouter provider slug to prefer, for example "deepinfra". Leave empty to keep OpenRouter\'s own routing.'),
  allowFallbacks: z
    .boolean()
    .default(true)
    .description('When true, OpenRouter falls back to its default routing if the preferred provider cannot serve the request. When false, only that provider may serve it.'),
})

/**
 * Apply the configured provider preference.
 *
 * Both layers live for the lifetime of this plugin fiber: a configuration
 * change or disable restores every touched catalog entry and request model
 * before the next generation installs its own preference.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ provider?: string, allowFallbacks?: boolean }} config - validated configuration.
 */
export function apply(ctx, config) {
  const provider = normalizeProviderName(config?.provider)
  if (provider === '') {
    ctx.logger.debug('openrouter-provider-routing: no provider configured; leaving OpenRouter routing unchanged')
    return
  }

  const allowFallbacks = config?.allowFallbacks !== false
  const routing = buildOpenRouterRouting(provider, allowFallbacks)
  if (routing === undefined) return

  const catalog = installCatalogRouting(ctx, routing)
  const patcher = createModelRoutingPatcher(routing)
  let warnedUnpatchable = false
  let warnedUnresolvable = false
  let warnedWireProtocol = false

  ctx.on('llm/stream', (options, next) => {
    try {
      const model = resolveAdapterModel(ctx.get('llm'), options.provider, options.model)
      if (model === undefined) {
        if (options.provider === OPENROUTER_PROVIDER_ID && !warnedUnresolvable) {
          warnedUnresolvable = true
          ctx.logger.warn(
            `openrouter-provider-routing: cannot resolve the live model for provider route "openrouter"; this request uses OpenRouter's own routing`,
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
            `openrouter-provider-routing: provider "${provider}" could not be attached to the live OpenRouter model; this request uses OpenRouter's own routing`,
          )
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
      `openrouter-provider-routing: preferring OpenRouter provider "${provider}" ${mode}; the installed catalog could not be shaped, so requests are steered per stream`,
    )
    return
  }
  if (catalog.applied === 0) {
    ctx.logger.warn(
      `openrouter-provider-routing: could not shape any installed OpenRouter catalog model (${catalog.skipped} frozen or invalid); requests fall back to per-stream shaping`,
    )
    return
  }
  ctx.logger.info(
    `openrouter-provider-routing: preferring OpenRouter provider "${provider}" ${mode} for ${catalog.applied} catalog model(s)`,
  )
}

/**
 * Shape the installed OpenRouter catalog, tolerating an unavailable or
 * unexpected pi-ai module.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} routing - request-body `provider` object.
 * @returns {{ applied: number, dispose(): void } | undefined} installed catalog patch.
 */
function installCatalogRouting(ctx, routing) {
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
  return applyOpenRouterRouting(models, routing)
}
