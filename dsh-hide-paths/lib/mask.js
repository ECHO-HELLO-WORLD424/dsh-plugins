/**
 * Masking mechanics for dsh-hide-paths.
 *
 * The goal is absence, not denial: a configured path must answer ENOENT from
 * every surface an agent can reach, so no access-denied marker ever proves it
 * exists. On Linux the only view that survives arbitrary child programs is the
 * mount namespace the harness already builds with bubblewrap, so this module
 * synthesizes mounts that remove the entry from its parent directory.
 *
 * A single mount cannot hide a *name* (`--tmpfs <dir>` hides contents but the
 * entry stays listed), so the parent is shadowed instead: an empty staging
 * directory holding a placeholder for every VISIBLE sibling is bound over the
 * parent, then each visible sibling is bound back onto its placeholder. The
 * hidden name never exists in the composed tree, while every other entry keeps
 * its real inode identity (bind mounts, not symlinks).
 *
 * bubblewrap applies mount operations in argv order (verified against
 * bubblewrap 0.11.1 setup_newroot), so the staging bind is emitted before the
 * sibling binds and any writable root underneath is re-bound last.
 *
 * @module dsh-hide-paths/mask
 */

import { createHash } from 'node:crypto';
import { constants, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Plugin name used by loader diagnostics and error prefixes. */
export const PLUGIN_NAME = 'hide-paths';

/** Where synthesized parent views live; deliberately outside the sandbox's tmpfs `/tmp`. */
export const DEFAULT_STAGING_ROOT = '/var/tmp/dsh-hide-paths';

/**
 * Trees that can never be hidden: they are ephemeral in the sandbox, hold the
 * staging area itself, or are mounted by bubblewrap after `--ro-bind / /`, so
 * shadowing their parents would break the sandbox rather than hide anything.
 */
const FORBIDDEN_TREES = ['/tmp', '/var/tmp', '/proc', '/sys', '/dev', '/run'];

/** Refuse a tree the sandbox owns, remounts, or treats as scratch space. */
function assertMaskable(path, tree) {
	if (!under(path, tree)) return;
	throw new Error(`${PLUGIN_NAME}: refusing to hide ${JSON.stringify(path)}: ${tree} is not maskable (ephemeral in the sandbox, or owned by the sandbox itself)`);
}

/** Whether a `stat` mode names a regular file / directory (not a socket, fifo, or device). */
const isFileMode = (mode) => (mode & constants.S_IFMT) === constants.S_IFREG;
const isDirectoryMode = (mode) => (mode & constants.S_IFMT) === constants.S_IFDIR;

/**
 * Whether `path` is `root` itself or lies beneath it.
 * @param path - normalized absolute candidate.
 * @param root - normalized absolute root.
 * @returns true for the root and every descendant.
 */
export function under(path, root) {
	if (path === root) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return path.startsWith(prefix);
}

/**
 * Validate the configured paths once at activation. Everything that can be
 * decided without a session is decided here, and a bad entry fails the plugin
 * load instead of degrading into weaker hiding later.
 * @param entries - raw `hide` config values.
 * @returns canonical paths, deduplicated with nested paths folded into ancestors.
 * @throws when an entry is relative, missing, or lives in a tree that cannot be masked.
 */
export function resolveHiddenPaths(entries) {
	const resolved = [];
	for (const raw of entries) {
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			throw new Error(`${PLUGIN_NAME}: every "hide" entry must be a non-empty path string`);
		}
		if (!isAbsolute(raw)) throw new Error(`${PLUGIN_NAME}: hide path must be absolute: ${JSON.stringify(raw)}`);
		const trees = [...FORBIDDEN_TREES, tmpdir()];
		const spelled = normalize(raw);
		for (const tree of trees) assertMaskable(spelled, tree);
		const path = realpathSync(spelled);
		for (const tree of trees) assertMaskable(path, tree);
		if (path === sep) throw new Error(`${PLUGIN_NAME}: refusing to hide "/"`);
		const parent = dirname(path);
		if (parent === sep) {
			throw new Error(`${PLUGIN_NAME}: refusing to hide ${JSON.stringify(path)}: its parent is the filesystem root, whose /proc, /dev, and /sys mounts cannot be shadowed safely`);
		}
		const type = lstatSync(path).mode;
		if (!isFileMode(type) && !isDirectoryMode(type)) {
			throw new Error(`${PLUGIN_NAME}: refusing to hide ${JSON.stringify(path)}: only regular files and directories can be shadowed`);
		}
		resolved.push(path);
	}
	const kept = [];
	for (const path of [...new Set(resolved)].sort((left, right) => left.length - right.length)) {
		if (!kept.some((ancestor) => under(path, ancestor))) kept.push(path);
	}
	return kept;
}

/**
 * Refuse a policy under which the hidden tree cannot be masked without breaking
 * the session. The workspace is the one writable root whose view must stay real,
 * so a hidden path may neither contain it nor live inside it.
 * @param hidden - canonical hidden paths.
 * @param workspaceRoot - the policy's writable workspace root.
 * @throws when the two overlap.
 */
export function assertHideable(hidden, workspaceRoot) {
	for (const path of hidden) {
		if (under(workspaceRoot, path)) {
			throw new Error(`cannot hide ${JSON.stringify(path)}: the session workspace ${JSON.stringify(workspaceRoot)} is inside it`);
		}
		if (under(path, workspaceRoot)) {
			throw new Error(`cannot hide ${JSON.stringify(path)}: it is inside the writable workspace ${JSON.stringify(workspaceRoot)}, whose view must stay real`);
		}
	}
}

/** Placeholder kind for one directory entry. */
function entryKind(entry) {
	if (entry.isSymbolicLink()) return 'l';
	if (entry.isDirectory()) return 'd';
	if (entry.isFile()) return 'f';
	return 'o';
}

/** Recreate the parent's visible entries as mount-point placeholders. */
function rebuildStage(stage, parent, visible) {
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true });
	for (const entry of visible) {
		const source = join(parent, entry.name);
		const target = join(stage, entry.name);
		switch (entryKind(entry)) {
			case 'd':
				mkdirSync(target);
				break;
			case 'f':
				writeFileSync(target, '');
				break;
			case 'l':
				symlinkSync(readlinkSync(source), target);
				break;
			default:
				throw new Error(`${PLUGIN_NAME}: cannot hide a name beside ${JSON.stringify(source)}: unsupported entry type (only files, directories, and symlinks can be shadowed)`);
		}
	}
}

/**
 * Build (or refresh) the shadow view for every parent that contains a hidden
 * entry. Staging is rebuilt whenever the parent's visible listing changes, so a
 * long-lived host process never serves a stale directory view.
 * @param hidden - canonical hidden paths.
 * @param stagingRoot - directory that owns the synthesized views.
 * @returns one shadow per parent, ordered shallowest first (ancestors must be
 *   shadowed before a nested parent is shadowed inside them).
 */
export function buildShadows(hidden, stagingRoot = DEFAULT_STAGING_ROOT) {
	mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
	const groups = new Map();
	for (const path of hidden) {
		const parent = dirname(path);
		const names = groups.get(parent);
		if (names === undefined) groups.set(parent, new Set([path.slice(parent.length + 1)]));
		else names.add(path.slice(parent.length + 1));
	}
	const shadows = [];
	for (const [parent, names] of [...groups.entries()].sort((left, right) => left[0].length - right[0].length)) {
		if (under(stagingRoot, parent) || under(parent, stagingRoot)) {
			throw new Error(`${PLUGIN_NAME}: stagingRoot ${JSON.stringify(stagingRoot)} must live outside the shadowed parent ${JSON.stringify(parent)}`);
		}
		const key = createHash('sha256').update(parent).digest('hex').slice(0, 16);
		const stage = join(stagingRoot, key, 'stage');
		shadows.push({ parent, stage, names, visible: [], signature: null });
	}
	refreshShadows(shadows);
	return shadows;
}

/**
 * Recompute every shadow's visible entries, rebuilding its staging directory
 * only when the listing (or the hidden set) changed.
 * @param shadows - shadows produced by {@link buildShadows}.
 */
export function refreshShadows(shadows) {
	for (const shadow of shadows) {
		const entries = readdirSync(shadow.parent, { withFileTypes: true });
		const visible = entries.filter((entry) => !shadow.names.has(entry.name));
		const signature = [...shadow.names].sort().join('\u0001')
			+ '\u0002'
			+ visible.map((entry) => `${entry.name}\u0000${entryKind(entry)}`).sort().join('\u0001');
		if (signature !== shadow.signature) {
			rebuildStage(shadow.stage, shadow.parent, visible);
			shadow.signature = signature;
		}
		shadow.visible = visible;
	}
}

/** Whether `path` is one of the policy's writable roots or lies beneath one. */
function writable(path, roots) {
	return roots.some((root) => under(path, root));
}

/**
 * The mount arguments that compose the masked view for one policy.
 * @param shadows - refreshed shadows.
 * @param policy - the per-call sandbox policy (mode and workspace root).
 * @returns bubblewrap arguments (no trailing `--`), safe to inject before the separator.
 */
export function mountArgs(shadows, policy) {
	const writableRoots = policy.mode === 'workspace-write'
		? [policy.workspaceRoot, '/tmp', tmpdir()]
		: [];
	const args = [];
	const bound = new Set();
	for (const shadow of shadows) {
		args.push('--ro-bind', shadow.stage, shadow.parent);
		for (const entry of shadow.visible) {
			if (entry.isSymbolicLink()) continue;
			const source = join(shadow.parent, entry.name);
			args.push(writable(source, writableRoots) ? '--bind' : '--ro-bind', source, source);
			bound.add(source);
		}
	}
	if (policy.mode === 'workspace-write') {
		const root = policy.workspaceRoot;
		const shadowed = shadows.some((shadow) => under(root, shadow.parent));
		if (shadowed && !bound.has(root)) args.push('--bind', root, root);
	}
	return args;
}

/**
 * Insert mount arguments before the runner's `--` separator, so they execute
 * after the caller's own profile mounts.
 * @param argv - the confined argv returned by `confine`.
 * @param mounts - the mask arguments from {@link mountArgs}.
 * @returns the composed argv (the input array when there is nothing to add).
 */
export function injectMounts(argv, mounts) {
	if (mounts.length === 0) return argv;
	const separator = argv.indexOf('--');
	if (separator < 1) throw new Error(`${PLUGIN_NAME}: confined argv has no runner separator`);
	return [...argv.slice(0, separator), ...mounts, ...argv.slice(separator)];
}

/**
 * Whether a filesystem target is the hidden path or lies beneath it.
 * @param target - an `FsTarget` from the filesystem service.
 * @param hidden - canonical hidden paths.
 * @returns true when the target must appear absent.
 */
export function hiddenTarget(target, hidden) {
	const key = target?.targetKey;
	if (typeof key !== 'string' || key.length === 0) return false;
	const path = normalize(key);
	return hidden.some((entry) => under(path, entry));
}

/**
 * Whether a raw path (as passed to `lstat`) is hidden. Canonicalizes best-effort:
 * a path that still exists is realpath'd, a missing one is compared lexically.
 * @param path - absolute or cwd-relative path.
 * @param cwd - base for relative paths.
 * @param hidden - canonical hidden paths.
 * @returns true when the path must appear absent.
 */
export function hiddenPath(path, cwd, hidden) {
	if (typeof path !== 'string' || path.length === 0) return false;
	let absolute = resolve(cwd ?? process.cwd(), path);
	try {
		absolute = realpathSync(absolute);
	} catch {
		// A missing path is compared as spelled; its ancestors are already real.
	}
	return hidden.some((entry) => under(absolute, entry));
}

/**
 * A Node-shaped "no such file" error, so callers that only classify errno still
 * see an absent path rather than a policy denial.
 * @param displayPath - the path to name in the message.
 * @returns the error to throw.
 */
export function notFound(displayPath) {
	const error = new Error(`ENOENT: no such file or directory, open '${displayPath}'`);
	error.code = 'ENOENT';
	error.errno = -2;
	error.syscall = 'open';
	error.path = displayPath;
	return error;
}

/**
 * Remove this activation's synthesized staging views.
 * @param shadows - the shadows whose staging directories to delete.
 */
export function disposeStaging(shadows) {
	for (const shadow of shadows) rmSync(dirname(shadow.stage), { recursive: true, force: true });
}
