# dsh-hide-paths

Make configured paths **nonexistent** in the DeepSeek Harness sandbox — not
forbidden. An agent that runs `cd ..` and `ls`, `cat`, `grep`, or `find` sees a
parent directory that simply has no such entry. Nothing on the host changes:
the directory, its permissions, its contents, and its backups stay exactly
where they are.

This is deliberately different from an access-denial policy. A denied path
answers `EACCES` (or `[sandbox: file access denied …]`) and thereby proves the
path exists. This plugin removes the entry from the agent's view instead, so the
only observable answer is `ENOENT`.

## How it works

Three separate surfaces must agree, because they do not share one view:

1. **Confined commands** (`bash`, persistent terminals, PTC `run_code`). The
   harness already runs them under `bwrap --ro-bind / / …`. The plugin wraps
   `ctx.sandbox.confine` and appends mounts that shadow the hidden path's
   **parent**: an empty staging directory holding a placeholder for every
   *visible* sibling is bound over the parent, and each visible sibling is bound
   back onto its placeholder. The hidden name never exists in the composed tree;
   every other entry keeps its real inode identity (bind mounts, not symlinks).
   A writable workspace beneath a shadowed parent is re-bound read-write last.
   Mounts run in argv order, so the composition is deterministic.
2. **File tools** (`read`, `write`, `edit`, `present`, `read_image`, the Web UI
   file browser). These read in-process through `ctx.fs`. Hidden targets report
   absence: `stat`/`lstat` return `undefined`, listings drop hidden entries, and
   reads/writes raise a normal `ENOENT`.
3. **Search tools** (`glob`, `grep`). These spawn the packaged `ripgrep`
   deliberately unconfined, so the plugin wraps `ctx.subprocess.spawn` and runs
   those `rg` invocations inside the same read-only masked view. Results never
   have to be filtered after the fact.

## Configure

```yaml
- id: hide-paths
  name: dsh-hide-paths
  config:
    hide:
      - /home/patrick/Data/web/echo-hello-world424.github.io
```

Every entry must be an absolute path to an existing directory or regular file.
Nested entries fold into their ancestor. An empty list leaves the plugin inert.

A profile patch that overrides this row replaces the whole config, so restate
`hide` in full there.

The plugin deliberately exports no `Config` schema: a workspace-linked bundle
cannot resolve the harness's schema package (`@deepseek-ai/schemastery`), so the
config is validated in `apply` and an invalid entry fails the load with a clear
error instead.

## Strict by design

If a configured path cannot be masked faithfully, the plugin **refuses instead
of degrading**:

- At load, it rejects relative paths, `/`, paths whose parent is `/`, paths
  under `/tmp`, `/var/tmp`, `/proc`, `/sys`, `/dev`, or `/run`, missing paths,
  and sibling entries that are not files, directories, or symlinks.
- Per session, it refuses a policy whose writable workspace is the hidden path,
  contains it, or is contained by it. Confinement then fails closed with a
  deliberately **path-free** error, and the detailed reason goes to the host log
  only — a denial message must never leak the name it is hiding.

## Limits

- **`danger-full-access` sessions** bypass `confine()` entirely, so nothing is
  masked there. Hiding is a property of the confined view, not of the account.
- **Linux/bubblewrap only.** Other sandbox backends (Landlock, Seatbelt,
  Windows ACL) have no mount composition, so activation fails on them rather
  than pretending.
- Programs the harness spawns outside the sandbox seams above — for example an
  MCP server — are not masked.
- A shell outside the harness (the user's own terminal) is unaffected, as it
  should be.

## Verify

From a confined session:

```bash
ls -la /home/patrick/Data/web            # the hidden entry is absent
stat /home/patrick/Data/web/<hidden>     # ENOENT
```

and in the tools: `read` on a hidden file reports not-found, `glob`/`grep`
started at the parent return nothing from it.

## Tests

```bash
node --test test/mask.test.js
```
