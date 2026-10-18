/** pi-ai catalog id of the provider this plugin shapes. */
export declare const OPENROUTER_PROVIDER_ID: 'openrouter'

/** Read a configured provider name, trimming and rejecting non-strings. */
export declare function normalizeProviderName(value: unknown): string

/** Read a configured model id, trimming and rejecting non-strings. */
export declare function normalizeModelId(value: unknown): string

/** Build the request-body `provider` object, or `undefined` when unset. */
export declare function buildOpenRouterRouting(
  provider: unknown,
  allowFallbacks?: boolean,
): Record<string, unknown> | undefined

/** Attach routing to every mutable model in a catalog and return the inverse. */
export declare function applyOpenRouterRouting(
  models: readonly object[],
  routing: Record<string, unknown>,
): { applied: number; skipped: number; dispose(): void }

/** Whether a resolved model sends its requests to OpenRouter. */
export declare function isOpenRouterModel(model: unknown): boolean

/** Resolve the concrete pi-ai model object an adapter will stream. */
export declare function resolveAdapterModel(
  runtime: unknown,
  provider: string,
  modelId: string,
): object | undefined

/** Shape individual models as requests reach the adapter. */
export declare function createModelRoutingPatcher(routing: Record<string, unknown>): {
  patch(model: unknown): boolean
  dispose(): void
  readonly size: number
}

/** Remove one generation's routing from every live adapter snapshot. */
export declare function stripOpenRouterRoutingFromRuntime(
  runtime: unknown,
  routing: Record<string, unknown>,
): number
