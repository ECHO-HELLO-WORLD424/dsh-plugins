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
{ "provider": { "order": ["deepseek"], "allow_fallbacks": false } }
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

## `dsh-hide-paths`

Make configured paths **nonexistent** in the sandbox instead of merely
forbidden. An agent that runs `cd ..` and `ls`, `grep`, `cat`, or `find` sees a
parent directory that has no such entry, so nothing on the host is revealed —
not even the name. Access-denial approaches (`EACCES`, `[sandbox: file access
denied …]`) prove existence and are deliberately not used here.

```yaml
# your profile's cordis.patch.yml (or the bundle's own row)
- id: hide-paths
  name: dsh-hide-paths
  config:
    hide:
      - /home/patrick/Data/web/echo-hello-world424.github.io
```

The plugin composes mounts into the bubblewrap view used for confined commands,
mirrors that absence through the in-process filesystem service, and runs the
packaged `ripgrep` inside the same masked view. The real directories are never
touched; only the sandbox's view of them changes.

It fails closed: an unmaskable path (inside the writable workspace, under
`/tmp`, parent `/`, …) refuses the plugin load rather than degrading to weaker
hiding, and runtime refusal never names the hidden path.

See the [plugin README](dsh-hide-paths/README.md) for the mechanism, strictness
rules, verification commands, and limits (`danger-full-access` sessions bypass
confinement, and masking is Linux/bubblewrap only).

## `dsh-gpu-patch`

Grant the host NVIDIA device nodes to `workspace-write` sandbox sessions, so
CUDA, NVML, and `nvidia-smi` work inside the sandbox instead of silently
falling back to the CPU.

```yaml
# your profile's cordis.patch.yml (or the bundle's own row)
- id: gpu-patch
  name: dsh-gpu-patch
  config:
    extraNodes: []
```

DSH's sandbox profile starts with `--dev /dev`, which installs a fresh minimal
device tree, so `/dev/nvidia*` does not exist inside it. This plugin wraps
`ctx.sandbox.confine` and appends a `--dev-bind` for every NVIDIA node that
exists on the host, for `workspace-write` sessions only.

Because it is a runtime wrapper and not an edit to the installed package, it
survives DSH updates and activates without a restart. Nodes are discovered
automatically (`extraNodes` covers a non-standard path), read-only sessions are
untouched, and no additional filesystem write grant is made.

It fails soft: when the selected backend is not bubblewrap the plugin logs one
warning and leaves the GPU hidden rather than failing the command.

See the [plugin README](dsh-gpu-patch/README.md) for the mechanism,
verification commands, the `legacy/` shell fallback, and limits (Linux and
bubblewrap only, profile-wide, no per-session GPU isolation).
