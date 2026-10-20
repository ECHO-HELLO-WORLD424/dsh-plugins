#!/usr/bin/env bash
# [dsh-gpu-patch] Revert the GPU-passthrough patch from every installed copy of
# @deepseek-ai/dsh-sandbox-local, using the .dsh-gpu-patch.orig backup left by
# apply.sh.
#
# Usage:
#   tools/dsh-gpu-patch/restore.sh                 # restore every installed copy
#   tools/dsh-gpu-patch/restore.sh <lib/index.js>  # restore a specific copy
set -euo pipefail

targets=()
if [ "$#" -gt 0 ]; then
	targets=("$@")
else
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
			[ -d "$root" ] && find "$root" -maxdepth 7 \
				-name 'index.js.dsh-gpu-patch.orig' -type f 2>/dev/null
		done | sort -u
	)
fi

if [ "${#targets[@]}" -eq 0 ]; then
	echo "restore.sh: no .dsh-gpu-patch.orig backup found - nothing to restore."
	exit 0
fi

for backup in "${targets[@]}"; do
	original="${backup%.dsh-gpu-patch.orig}"
	if [ ! -f "$original" ]; then
		echo "!! skipping $backup: expected original $original is missing" >&2
		continue
	fi
	cp -- "$backup" "$original"
	echo "-> restored $original"
done

echo
echo "Done. RESTART DSH for the revert to take effect."
