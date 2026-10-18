# dsh-openrouter-provider-routing

A DeepSeek Harness plugin that lets you prefer one OpenRouter upstream provider
for **one specific model**, while still falling back to OpenRouter's normal
routing when that provider cannot serve the request.

Set a provider slug and a model id, and requests for that model carry:

```json
{
  "provider": {
    "order": ["deepinfra"],
    "allow_fallbacks": true
  }
}
```

Requests for every other model are left on OpenRouter's own routing. `order`
makes OpenRouter try your provider first. `allow_fallbacks` keeps OpenRouter's
default routing as the safety net, so a provider that is down or rate limited
does not break the request. The plugin never contacts OpenRouter itself and does
not validate the slug or model id — you are responsible for using the exact
values.

Scoping to one model is deliberate: an upstream provider that serves the model
you pin may not serve every other model in your catalog. Pinning all models to
one provider would make those other requests fail; this plugin only shapes the
model you configured.

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
    model: ''
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
    model: 'deepseek/deepseek-v4.1-flash'
    allowFallbacks: true
```

A profile patch replaces the targeted row's whole `config`, so repeat every
field you want to keep. The bundle row is inert while either `provider` or
`model` is empty; `disabled: true` also turns the plugin off.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | OpenRouter provider slug to prefer, for example `deepinfra`, `together`, `fireworks`, or `groq`. Whitespace is trimmed. Empty leaves OpenRouter routing untouched. |
| `model` | `''` | Exact OpenRouter model id to shape, for example `deepseek/deepseek-v4.1-flash`. Only requests whose model id equals this string are shaped; every other model keeps OpenRouter's routing. Whitespace is trimmed. Empty leaves OpenRouter routing untouched. |
| `allowFallbacks` | `true` | When `true`, `order` + `allow_fallbacks: true`: your provider is preferred for the configured model, and OpenRouter falls back to its normal routing when it cannot serve the request. When `false`, `only` + `allow_fallbacks: false`: the request for that model is pinned to that provider and fails rather than substituting another one. |

If DSH runs with live patch reload, the next request uses the new preference.
Otherwise restart the profile (or the Desktop app) after editing the patch.

### Finding a provider slug and model id

OpenRouter's request-level routing takes **provider slugs**, not display names,
and model ids are the exact `provider/model` strings the API receives. Browse the
providers list at <https://openrouter.ai/providers>, the models list at
<https://openrouter.ai/models>, or read
[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
for the `order`, `only`, and `allow_fallbacks` fields. The plugin deliberately
does not fetch or validate either value.

The model id must match what DSH sends to OpenRouter **exactly**. If your
`llm-pi-ai` route config lists the model as `deepseek/deepseek-v4.1-flash`, use
that same string here — including any prefix such as `~` that appears in the
configured id.

## Behavior details

### Prefer a provider for one model, keep OpenRouter's fallback

```yaml
config:
  provider: 'deepinfra'
  model: 'deepseek/deepseek-v4.1-flash'
  allowFallbacks: true
```

Requests for `deepseek/deepseek-v4.1-flash` send `order: ["deepinfra"]` +
`allow_fallbacks: true`. OpenRouter tries `deepinfra` first. If that provider is
unavailable, rate limited, or does not offer the model, it continues with its
normal policy (price-based load balancing among healthy providers). Requests for
any other model send no `provider` object and keep OpenRouter's default routing.

### Pin a provider for one model, no fallback

```yaml
config:
  provider: 'deepinfra'
  model: 'deepseek/deepseek-v4.1-flash'
  allowFallbacks: false
```

This sends `only: ["deepinfra"]` and `allow_fallbacks: false` for that model
only. OpenRouter fails the request with its own error when that provider cannot
serve it; other models remain unaffected.

### Which requests are shaped

All three conditions must hold:

- The request's model id equals the configured `model`.
- The request goes through a pi-ai adapter route named `openrouter`, or through a
  custom pi-ai route whose `baseURL` is on `openrouter.ai` (for example an alias
  route pointing at `https://openrouter.ai/api/v1`).
- The model speaks the `openai-completions` wire protocol (see Limitations).

Blank values, other model ids, and non-OpenRouter traffic are left untouched.

### Wiring

DSH's pi-ai adapter resolves each model from pi-ai's installed catalog and hands
it to pi-ai's OpenAI-completions transport. pi-ai turns
`model.compat.openRouterRouting` into the request-body `provider` object. The
plugin puts that field on the configured model that the adapter actually
streams:

1. At plugin activation it shapes only the configured model's entry in the
   installed OpenRouter catalog, covering model sets resolved after that point.
2. An `llm/stream` listener shapes the concrete model object the adapter built
   before activation (or builds for a custom model id). This second layer also
   covers model ids that are not in the installed catalog.

The listener matches `options.model` before doing any work, so a request for a
different model never carries this plugin's preference. There is no proxy, no
second LLM adapter, and no credential handling here: your existing OpenRouter
route keeps its `apiKeyEnv` and endpoint.

### Logs

On activation with both values set, DSH logs one line, for example:

```text
openrouter-provider-routing: preferring OpenRouter provider "deepinfra" for model "deepseek/deepseek-v4.1-flash" with OpenRouter fallback
```

If only one of `provider` and `model` is set, the plugin warns and stays inert.
To confirm which upstream served a real request, use OpenRouter's
[Activity](https://openrouter.ai/activity) page; the request's provider is
recorded there.

## Limitations

- **Chat Completions only.** pi-ai only writes `provider` for the
  `openai-completions` wire protocol. OpenRouter routes configured with
  `api: anthropic-messages` (or a Responses protocol) do not receive the field.
- **One configured model per plugin instance.** The configuration describes a
  single model id; requesting a provider preference for several models needs
  several plugin rows (or a small code change to accept a list).
- **Model ids are matched exactly.** A typo silently leaves requests on
  OpenRouter's routing. Compare against the model id configured in your
  `llm-pi-ai` route.
- **OpenRouter account settings still apply.** Your account-wide allowed,
  ignored, or privacy-filtered providers remain a ceiling on top of the
  request-level preference.
- **Provider slugs are not validated.** A typo is sent as-is; OpenRouter then
  falls back like any other unavailable provider (or fails in strict mode).
- **Relies on pi-ai's `compat.openRouterRouting` and DSH's live pi-ai model
  snapshot.** Tested with DSH `0.2.0-rc.2` and pi-ai `0.87.1`. If a future
  release renames those internals, the plugin logs a warning when it cannot
  shape the live model and leaves the request on OpenRouter's own routing.
- **No provider or model list is fetched.** No network calls happen in this
  plugin.

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
