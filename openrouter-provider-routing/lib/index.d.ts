import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** Validated plugin configuration. */
export interface Config {
  /**
   * OpenRouter provider slug to prefer, for example `deepinfra`.
   * Empty (the default) leaves OpenRouter's own routing unchanged.
   */
  provider: string
  /**
   * Exact OpenRouter model id to shape, for example
   * `deepseek/deepseek-v4.1-flash`. Only requests for this model receive the
   * provider preference. Empty (the default) leaves OpenRouter's own routing
   * unchanged.
   */
  model: string
  /**
   * Whether OpenRouter may substitute another provider when the preferred one
   * cannot serve the request. Defaults to `true`.
   */
  allowFallbacks: boolean
}

/** Cordis plugin name. */
export declare const name: 'openrouter-provider-routing'

/** Configuration schema. */
export declare const Config: z<Schemastery.ObjectS<{
  provider: z<string>
  model: z<string>
  allowFallbacks: z<boolean>
}>>

/** Apply the configured OpenRouter provider preference to one model. */
export declare function apply(ctx: Context, config: Config): void
