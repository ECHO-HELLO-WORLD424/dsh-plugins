# dsh-gpu-patch — GPU access for DSH sandboxed commands

Lets commands run by DSH in `workspace-write` mode see the host GPU, so CUDA
frameworks such as JAX use the GPU instead of silently falling back to the CPU.

## The problem

DSH's Linux sandbox profile starts with `--dev /dev`, which installs a **fresh
minimal device tree**. Inside the sandbox `/dev` holds only
`null zero full random urandom tty pts shm`, so `/dev/nvidia*` does not exist.
CUDA's read-write open of the driver nodes therefore fails and JAX degrades
quietly:

| | inside `workspace-write` | outside the sandbox |
|---|---|---|
| `nvidia-smi` | `couldn't communicate with the NVIDIA driver` | RTX 4090, driver 610.43.02 |
| `jax.devices()` | `[CpuDevice(id=0)]` | `[CudaDevice(id=0)]` |
| `cuInit(0)` | `CUDA_ERROR_NO_DEVICE` | OK |

The GPU itself is fine — only the sandbox profile is missing the device nodes.
`dsh-sandbox-local` has no policy vocabulary for device grants (the only device
path it ever grants is `/dev/null`).

## How it works

`confine` is an ordinary service method, so this bundle wraps
`ctx.sandbox.confine` and appends `--dev-bind` pairs to the bubblewrap profile
before the `--` separator:

```
--dev-bind /dev/nvidia0 /dev/nvidia0
--dev-bind /dev/nvidiactl /dev/nvidiactl
--dev-bind /dev/nvidia-uvm /dev/nvidia-uvm
--dev-bind /dev/nvidia-uvm-tools /dev/nvidia-uvm-tools
--dev-bind /dev/nvidia-modeset /dev/nvidia-modeset
--dev-bind /dev/nvidia-caps /dev/nvidia-caps
```

Bubblewrap resolves a bind **source** against the host view and only pivots into
the new root afterwards, so binding after `--dev /dev` recreates the nodes in
the sandbox's fresh device tree.

Properties:

- **Narrow** — no new filesystem write grant; the workspace root is still the
  only writable path. `read-only` and `danger-full-access` sessions are
  untouched, so the bwrap probe that selects the runner behaves as before.
- **Auto-detecting** — the numbered nodes are discovered from `/dev`, so
  multi-GPU hosts need no configuration, and a node is bound only if it exists
  (bwrap aborts on a missing bind source).
- **Update-proof** — nothing under `node_modules` is edited, so a DSH/npx update
  cannot wipe it.
- **Live** — wrapping a service method activates through HMR; no restart.
- **Composable** — skips injection when the provider already binds the nodes
  (see `legacy/`), so both mechanisms can be present without duplicate mounts.

## Enable

It is a bundle; install it into a profile with DSH's plugin manager:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-gpu-patch
```

`cordis.patch.yml` inserts one row, `gpu-patch`. No configuration is required —
an empty `extraNodes` list means "discover from `/dev`". Add entries only for a
non-standard device path:

```yaml
- id: gpu-patch
  name: dsh-gpu-patch
  config:
    extraNodes:
      - /dev/nvidia10
```

A profile patch that overrides this row replaces the whole config, so restate
`extraNodes` in full when overriding it there.

The plugin deliberately exports no `Config` schema: a workspace-linked bundle
cannot resolve the harness's schema package (`@deepseek-ai/schemastery`), so the
config is validated in `apply` and an invalid entry fails the load instead of
silently granting the wrong devices.

## Verify

Inside a command started after the plugin is active:

```bash
nvidia-smi -L                                  # GPU 0: NVIDIA GeForce RTX 4090
python -c "import jax; print(jax.devices())"    # [CudaDevice(id=0)]
```

The activation log line names exactly what was granted:

```
gpu-patch: granting /dev/nvidia-caps, /dev/nvidia-modeset, /dev/nvidia-uvm,
/dev/nvidia-uvm-tools, /dev/nvidia0, /dev/nvidiactl to workspace-write sessions
```

## Tests

```sh
node --test     # 6 tests over the confine composition
```

The tests replace the provider and use `/dev/null` as a stand-in device, so they
assert where the `--dev-bind` pairs land without needing a GPU.

## Caveats

- **bwrap only.** The Landlock fallback (`landlockProfileArgs`) takes a grant
  list, not mounts, and is not patched. When Landlock is the selected backend
  the plugin logs one warning and leaves the GPU hidden rather than failing the
  command.
- **Linux only.** On other platforms the plugin is a no-op.
- **Profile-wide.** Every session in the profile that runs in `workspace-write`
  gets the GPU nodes, not just one workspace.
- **A GPU is still a shared resource.** Co-tenants see the same device; there is
  no per-session isolation or memory limit.
- **Not a supported setting.** Upstream report:
  [deepseek-harness discussion #2983](https://github.com/deepseek-ai/deepseek-harness/discussions/2983).

## Legacy shell patch

`legacy/apply.sh` edits the installed `@deepseek-ai/dsh-sandbox-local` package
directly. It still works and is machine-wide (it covers `dsh` runs with no
profile at all), but an npm/npx update overwrites it and a running server keeps
the old code until restarted. Prefer the bundle; keep this only for a profile
that cannot load it.

```sh
legacy/apply.sh                 # patch every installed copy found
legacy/apply.sh <lib/index.js>  # patch one specific copy
legacy/restore.sh               # revert from the .orig backup
```
