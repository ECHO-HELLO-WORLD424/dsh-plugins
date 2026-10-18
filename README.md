# DSH plugins

A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## `dsh-openrouter-provider-routing`

Prefer a chosen OpenRouter upstream provider for **one specific model**, while
keeping OpenRouter's default routing as the fallback when that provider is
unavailable. Every other model keeps OpenRouter's own routing, so a provider
that does not serve those models is never forced on them.

```yaml
# your profile's cordis.patch.yml
- id: openrouter-provider-routing
  name: 'dsh-openrouter-provider-routing'
  config:
    provider: 'deepseek'
    model: '~deepseek/deepseek-flash-latest'
    allowFallbacks: false
```

Requests for that model carry:

```json
{ "provider": { "order": ["deepinfra"], "allow_fallbacks": true } }
```

- `provider` is an OpenRouter provider slug (`deepinfra`, `together`, ...).
  The plugin does not fetch or validate slugs.
- `model` is the exact OpenRouter model id. Model ids are matched exactly; only
  that model's requests are shaped.
- With `allowFallbacks: true` (default), a provider that is down or rate limited
  falls through to OpenRouter's normal routing.
- With `allowFallbacks: false`, that model's request is pinned to the provider
  and fails instead of substituting another one.

Install it into a profile with DSH's plugin manager:

```sh
dsh plugin --profile <profile> add /absolute/path/to/openrouter-provider-routing
```

See the [plugin README](openrouter-provider-routing/README.md) for
configuration, behavior, verification, and limitations.
