# DSH plugins

A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## `dsh-openrouter-provider-routing`

Prefer a chosen OpenRouter upstream provider for every request, while keeping
OpenRouter's default routing as the fallback when that provider is unavailable.

```yaml
# your profile's cordis.patch.yml
- id: openrouter-provider-routing
  name: 'dsh-openrouter-provider-routing'
  config:
    provider: 'deepinfra'
    allowFallbacks: true
```

That produces this request-body preference on OpenRouter Chat Completions
calls:

```json
{ "provider": { "order": ["deepinfra"], "allow_fallbacks": true } }
```

- `provider` is an OpenRouter provider slug (`deepinfra`, `together`, ...).
  The plugin does not fetch or validate slugs.
- With `allowFallbacks: true` (default), a provider that is down, rate limited,
  or does not serve the model falls through to OpenRouter's normal routing.
- With `allowFallbacks: false`, the request is pinned to that provider and
  fails instead of substituting another one.

Install it into a profile with DSH's plugin manager:

```sh
dsh plugin --profile <profile> add /absolute/path/to/openrouter-provider-routing
```

See the [plugin README](openrouter-provider-routing/README.md) for
configuration, behavior, verification, and limitations.
