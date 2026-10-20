# dsh-gpu-patch — GPU access for the DSH workspace-write sandbox

Lets commands run by DSH in `workspace-write` mode see the host GPU, so JAX uses
`cuda` instead of silently falling back to the CPU.

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
path it ever binds is `/dev/null`), so this is a local patch to the installed
package.

## What it changes

Adds `--dev-bind <node> <node>` for every GPU node that exists on the host, and
**only in the `workspace-write` branch** of `bwrapProfileArgs`:

```
--dev-bind /dev/nvidia0 /dev/nvidia0          # computed by `gpuDeviceArgs()`
--dev-bind /dev/nvidiactl /dev/nvidiactl
--dev-bind /dev/nvidia-uvm /dev/nvidia-uvm
--dev-bind /dev/nvidia-uvm-tools /dev/nvidia-uvm-tools
--dev-bind /dev/nvidia-modeset /dev/nvidia-modeset
--dev-bind /dev/nvidia-caps /dev/nvidia-caps
```

Properties:

- **Narrow** — no new filesystem write grant; the workspace root is still the
  only writable path. Read-only sessions are untouched, so the bwrap probe that
  selects the runner behaves exactly as before.
- **Auto-detecting** — a node is bound only if it exists, because bwrap aborts
  on a missing `--dev-bind` source.
- **Idempotent** — re-running `apply.sh` is a no-op once the `[dsh-gpu-patch]`
  marker is present.

## Usage

```bash
tools/dsh-gpu-patch/apply.sh      # patch (finds the installed package itself)
tools/dsh-gpu-patch/restore.sh    # revert from the .orig backup
```

Then **restart DSH**. The sandbox provider builds its profiles in-process, so a
running server keeps using the old code until it is restarted.

Verify after the restart (no approval prompt, plain sandboxed command):

```bash
nvidia-smi -L
.pixi/envs/gpu/bin/python -c "import jax; print(jax.devices(), jax.default_backend())"
# -> [CudaDevice(id=0)] gpu
```

## Caveats

- **npm updates wipe it.** The patch lives in the npx/downloaded copy of
  `@deepseek-ai/dsh-sandbox-local`; re-run `apply.sh` after updating DSH. The
  backup is `lib/index.js.dsh-gpu-patch.orig` next to the patched file.
- **Machine-wide.** Every DSH session on this host that runs in
  `workspace-write` gets the GPU nodes, not just this workspace.
- **bwrap only.** The Landlock fallback (`landlockProfileArgs`) is not patched.
  bwrap is the active backend here; if bwrap ever becomes unusable, GPU access
  silently disappears again rather than failing loudly.
- **Upstream drift.** `apply.sh` aborts if its anchors no longer match exactly
  once, so a future layout change fails safely instead of corrupting the file.
- This is a local workaround, not a supported setting. The upstream report is
  [deepseek-harness discussion #2983](https://github.com/deepseek-ai/deepseek-harness/discussions/2983).
