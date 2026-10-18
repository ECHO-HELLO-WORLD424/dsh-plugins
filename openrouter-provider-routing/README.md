# dsh-openrouter-provider-routing

A DeepSeek Harness plugin that lets you prefer one OpenRouter upstream provider
and still fall back to OpenRouter's normal routing when that provider cannot
serve a request.

Set a provider slug such as `deepinfra` or `together`, and every OpenRouter
request from DSH carries:

```json
{
  "provider": {
    "order": ["deepinfra"],
    "allow_fallbacks": true
  }
}
```

`order` makes OpenRouter try your provider first. `allow_fallbacks` keeps
OpenRouter's default routing as the safety net, so a provider that is down, rate
limited, or does not serve the selected model does not break the request. The
plugin never contacts OpenRouter itself and does not validate the slug — you are
responsible for using the exact provider slug.

## Install

Install the package into the DSH profile that runs OpenRouter, using any of
DSH's plugin installation paths:

```sh
# CLI-managed profile
dsh plugin --profile <profile> add /absolute/path/to/openrouter-provider-routing

# Or from a registry, if you publish it
dsh plugin --profile <profile> add dsh-openrouter-provider-routing
```

The package declares a bundle patch, so installation selects the bundle and
inserts this inert row into the composed tree:

```yaml
- id: openrouter-provider-routing
  name: 'dsh-openrouter-provider-routing'
  config:
    provider: ''
    allowFallbacks: true
```

With Desktop, use the app's **Plugins** page or the Desktop-bundled `dsh plugin`
command, which manages the app-owned profile. The npm CLI refuses package
operations for the reserved `desktop` profile.

## Configure

Override the row by id in your profile's `cordis.patch.yml`:

```yaml
- id: openrouter-provider-routing
  name: 'dsh-openrouter-provider-routing'
  config:
    provider: 'deepinfra'
    allowFallbacks: true
```

A profile patch replaces the targeted row's whole `config`, so repeat every
field you want to keep. The bundle row is inert while `provider` is empty;
`disabled: true` also turns the plugin off.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | OpenRouter provider slug to prefer, for example `deepinfra`, `together`, `fireworks`, or `groq`. Whitespace is trimmed. Empty leaves OpenRouter routing untouched. |
| `allowFallbacks` | `true` | When `true`, `order` + `allow_fallbacks: true`: your provider is preferred, and OpenRouter falls back to its normal routing when it cannot serve the request. When `false`, `only` + `allow_fallbacks: false`: the request is pinned to that provider and fails rather than substituting another one. |

If DSH runs with live patch reload, the next request uses the new preference.
Otherwise restart the profile (or the Desktop app) after editing the patch.

### Finding a provider slug

OpenRouter's request-level routing takes **slugs**, not display names. Browse
the providers list at <https://openrouter.ai/providers> or read
[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
for the `order`, `only`, and `allow_fallbacks` fields. The plugin deliberately
does not fetch or suggest slugs.

## Behavior details

### Prefer a provider, keep OpenRouter's fallback

```yaml
config:
  provider: 'deepinfra'
  allowFallbacks: true
```

OpenRouter tries `deepinfra` first. If that provider is unavailable, rate
limited, or does not offer the requested model, it continues with its normal
policy (price-based load balancing among healthy providers). This is the
behavior asked for by "route to my provider, but don't fail if it is down".

### Pin a provider, no fallback

```yaml
config:
  provider: 'deepinfra'
  allowFallbacks: false
```

This sends `only: ["deepinfra"]` and `allow_fallbacks: false`. OpenRouter fails
the request with its own error when that provider cannot serve it.

### Which requests are shaped

- Requests through DSH's pi-ai adapter route named `openrouter`.
- Requests through a custom pi-ai route whose `baseURL` is on `openrouter.ai`
  (for example an alias route pointing at `https://openrouter.ai/api/v1`).

Blank provider names and non-OpenRouter traffic are left untouched.

### Wiring

DSH's pi-ai adapter resolves each model from pi-ai's installed catalog and hands
it to pi-ai's OpenAI-completions transport. pi-ai turns
`model.compat.openRouterRouting` into the request-body `provider` object. The
plugin puts that field on the models the adapter actually streams:

1. At plugin activation it shapes the installed OpenRouter catalog, covering
   models resolved after that point.
2. An `llm/stream` listener shapes the concrete model object the adapter built
   before activation (or builds for a custom route). This second layer also
   covers model ids that are not in the installed catalog.

There is no proxy, no second LLM adapter, and no credential handling in this
plugin: your existing OpenRouter route keeps its `apiKeyEnv` and endpoint.

### Logs

On activation with a non-empty provider, DSH logs one info line:

```text
openrouter-provider-routing: preferring OpenRouter provider "deepinfra" with OpenRouter fallback for <n> catalog model(s)
```

To confirm which upstream served a real request, use OpenRouter's
[Activity](https://openrouter.ai/activity) page; the request's provider is
recorded there.

## Limitations

- **Chat Completions only.** pi-ai only writes `provider` for the
  `openai-completions` wire protocol. OpenRouter routes configured with
  `api: anthropic-messages` (or a Responses protocol) do not receive the field.
- **One preference for every OpenRouter route.** The configuration is global to
  the plugin instance; there is no per-model or per-route preference.
- **OpenRouter account settings still apply.** Your account-wide allowed,
  ignored, or privacy-filtered providers remain a ceiling on top of the
  request-level preference.
- **Provider slugs are not validated.** A typo is sent as-is; OpenRouter then
  falls back like any other unavailable provider (or fails in strict mode).
- **Relies on pi-ai's `compat.openRouterRouting` and DSH's live pi-ai model
  snapshot.** Tested with DSH `0.2.0-rc.2` and pi-ai `0.87.1`. If a future
  release renames those internals, the plugin logs a warning when it cannot
  shape the live model and leaves the request on OpenRouter's own routing.
- **No provider list is fetched.** No network calls happen in this plugin.

## Development

```sh
cd openrouter-provider-routing
pnpm install          # dev dependencies; the runtime peers stay shared with DSH
node --test test/
```

`@earendil-works/pi-ai` is a peer dependency because the plugin must shape the
same catalog instance the running DSH uses; installing a second copy inside the
plugin would shape a different module. `@deepseek-ai/schemastery` provides the
configuration schema.

| File | Role |
|---|---|
| `lib/index.js` | Cordis plugin, config schema, catalog patch, stream hook, cleanup |
| `lib/routing.js` | Pure routing-object builders and model-shaping helpers |
| `cordis.patch.yml` | Bundle patch inserting the inert configuration row |
| `test/` | Unit tests for the routing objects, patch lifecycle, and stream hook |

## License

MIT
