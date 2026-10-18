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
  allowFallbacks: z<boolean>
}>>

/** Apply the configured OpenRouter provider preference. */
export declare function apply(ctx: Context, config: Config): void
