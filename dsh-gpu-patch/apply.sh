#!/usr/bin/env bash
# [dsh-gpu-patch] Let DSH's workspace-write sandbox reach the host GPU.
#
# Background
# ----------
# DSH's Linux sandbox profile starts with `--dev /dev`, which installs a FRESH
# minimal device tree (null, zero, full, random, urandom, tty, pts, shm). The
# NVIDIA nodes are therefore absent inside the sandbox, so CUDA's read-write
# open of /dev/nvidiactl + /dev/nvidia0 fails with CUDA_ERROR_NO_DEVICE and JAX
# quietly falls back to the CPU backend:
#
#   jax.devices() -> [CpuDevice(id=0)]        inside the sandbox
#   jax.devices() -> [CudaDevice(id=0)]       outside the sandbox
#
# This script adds `--dev-bind <node> <node>` for the GPU nodes that actually
# exist on the host, and ONLY for `workspace-write` mode: read-only sessions are
# left untouched, and no extra filesystem write grant is added.
#
# The patch is idempotent and keeps a `.dsh-gpu-patch.orig` backup beside the
# patched file. It is local to this machine's installed copy, so re-run it after
# any DSH/npx update.
#
# You MUST restart DSH afterwards: the sandbox provider builds its profiles
# in-process, so a server that is already running keeps using the old code.
#
# Usage:
#   tools/dsh-gpu-patch/apply.sh                 # patch every installed copy
#   tools/dsh-gpu-patch/apply.sh <lib/index.js>  # patch a specific copy
#   tools/dsh-gpu-patch/restore.sh               # revert from the .orig backup
set -euo pipefail

PY="${PYTHON:-python3}"
MARKER="[dsh-gpu-patch]"

targets=()
if [ "$#" -gt 0 ]; then
	targets=("$@")
else
	# DSH runs from the npx cache here; global npm/pnpm roots are also checked so
	# the script keeps working if DSH is installed globally instead.
	roots=(
		"$HOME/.npm/_npx"
		"$HOME/.local/share/pnpm"
		"$HOME/.cache/pnpm"
		"/usr/lib/node_modules"
		"/usr/local/lib/node_modules"
	)
	while IFS= read -r hit; do
		[ -n "$hit" ] && targets+=("$hit")
	done < <(
		for root in "${roots[@]}"; do
			[ -d "$root" ] && find "$root" -maxdepth 6 \
				-path '*@deepseek-ai/dsh-sandbox-local/lib/index.js' -type f 2>/dev/null
		done | sort -u
	)
fi

if [ "${#targets[@]}" -eq 0 ]; then
	echo "apply.sh: no @deepseek-ai/dsh-sandbox-local/lib/index.js found." >&2
	echo "apply.sh: pass the path explicitly, e.g. apply.sh /path/to/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js" >&2
	exit 1
fi

status=0
for target in "${targets[@]}"; do
	echo "-> $target"
	"$PY" - "$target" <<'PYEOF' || status=$?
import pathlib
import re
import sys

MARKER = "[dsh-gpu-patch]"

# Device nodes CUDA/NVML needs. /dev/nvidia-caps only matters for MIG, but it is
# bound when present so capability queries do not fail on MIG-capable hosts.
HELPER = """/** [dsh-gpu-patch] Host GPU device nodes bound into workspace-write sessions. */
const GPU_DEVICE_NODES = [
\t"/dev/nvidia0",
\t"/dev/nvidiactl",
\t"/dev/nvidia-uvm",
\t"/dev/nvidia-uvm-tools",
\t"/dev/nvidia-modeset",
\t"/dev/nvidia-caps"
];
/**
* [dsh-gpu-patch] `--dev-bind` arguments for every GPU device node present on
* the host. `--dev /dev` installs a fresh minimal device tree, so CUDA's
* read-write open of the driver nodes fails with CUDA_ERROR_NO_DEVICE unless
* they are bound explicitly; bwrap aborts on a missing bind source, so only
* nodes that exist are bound.
* @returns bwrap arguments granting the host GPU device nodes.
*/
function gpuDeviceArgs() {
\tconst args = [];
\tfor (const node of GPU_DEVICE_NODES) if (existsSync(node)) args.push("--dev-bind", node, node);
\treturn args;
}
"""

ANCHOR_DOC = "* @module @deepseek-ai/dsh-sandbox-local/profiles\n*/\n"
ANCHOR_MODE = (
    '\tif (policy.mode === "workspace-write") {\n'
    '\t\targs.push("--tmpfs", "/tmp");\n'
    '\t\targs.push("--bind", policy.workspaceRoot, policy.workspaceRoot);\n'
    "\t}\n"
)
REPL_MODE = (
    '\tif (policy.mode === "workspace-write") {\n'
    '\t\targs.push("--tmpfs", "/tmp");\n'
    '\t\targs.push("--bind", policy.workspaceRoot, policy.workspaceRoot);\n'
    "\t\targs.push(...gpuDeviceArgs()); // " + MARKER + "\n"
    "\t}\n"
)

path = pathlib.Path(sys.argv[1])
src = path.read_text(encoding="utf-8")

if MARKER in src:
    print("   already patched - nothing to do")
    raise SystemExit(0)

if not re.search(r"\bexistsSync\b", src):
    print("   ABORT: `existsSync` is not imported in this file; refusing to patch.")
    raise SystemExit(2)

for label, anchor in (("module doc", ANCHOR_DOC), ("workspace-write block", ANCHOR_MODE)):
    found = src.count(anchor)
    if found != 1:
        print(f"   ABORT: anchor '{label}' matched {found}x (expected exactly 1).")
        print("   Upstream layout changed - update ANCHOR_* in this script.")
        raise SystemExit(2)

patched = src.replace(ANCHOR_DOC, ANCHOR_DOC + HELPER, 1)
patched = patched.replace(ANCHOR_MODE, REPL_MODE, 1)

backup = path.parent / (path.name + ".dsh-gpu-patch.orig")
if not backup.exists():
    backup.write_text(src, encoding="utf-8")
    print(f"   backup written: {backup}")
else:
    print(f"   backup kept   : {backup}")

path.write_text(patched, encoding="utf-8")
print("   patched: GPU nodes granted to workspace-write sessions")
PYEOF
done

echo
if [ "$status" -eq 0 ]; then
	echo "Done. RESTART DSH for the change to take effect (profiles are built in-process)."
	echo "Undo with: $(dirname "$0")/restore.sh"
else
	echo "One or more targets failed; nothing else was attempted." >&2
fi
exit "$status"
