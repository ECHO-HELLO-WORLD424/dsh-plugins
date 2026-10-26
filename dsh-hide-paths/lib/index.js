/**
 * dsh-hide-paths — make configured paths absent from the sandbox.
 *
 * Three layers must agree, because they do not share a view:
 *
 * 1. `ctx.sandbox.confine` — every confined command (bash, persistent terminal,
 *    PTC runtime) becomes a bubblewrap invocation. Extra mounts remove the
 *    hidden entry from its parent, so child programs observe ENOENT rather
 *    than a denial.
 * 2. `ctx.fs` — the model-facing file tools and the Web UI file browser read
 *    in-process. Hidden targets report absence there as well.
 * 3. `ctx.subprocess` — `glob`/`grep` spawn the packaged ripgrep deliberately
 *    unconfined, so those spawns are wrapped in the same read-only masked view
 *    instead of post-filtering their output.
 *
 * Nothing here is a permission layer: no path is denied, and no error text
 * names a hidden entry. When a session's workspace makes masking impossible,
 * confinement fails closed with a path-free message.
 *
 * @module dsh-hide-paths
 */

import { basename } from 'node:path';
import {
	DEFAULT_STAGING_ROOT,
	PLUGIN_NAME,
	assertHideable,
	buildShadows,
	disposeStaging,
	hiddenPath,
	hiddenTarget,
	injectMounts,
	mountArgs,
	notFound,
	refreshShadows,
	resolveHiddenPaths
} from './mask.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME;

/** Services this plugin wraps; activation waits for all three. */
export const inject = ['fs', 'sandbox', 'subprocess'];

/** Read the row config without a schema dependency (see the package README). */
function readConfig(config) {
	const hide = config?.hide;
	if (hide !== undefined && !Array.isArray(hide)) throw new Error(`${PLUGIN_NAME}: "hide" must be a list of absolute paths`);
	const stagingRoot = config?.stagingRoot;
	if (stagingRoot !== undefined && typeof stagingRoot !== 'string') {
		throw new Error(`${PLUGIN_NAME}: "stagingRoot" must be a string`);
	}
	return { hide: hide ?? [], stagingRoot: stagingRoot ?? DEFAULT_STAGING_ROOT };
}

/**
 * Wrap one service method so hidden targets read as absent.
 * @param owner - the service instance that owns the method.
 * @param method - the method name to shadow.
 * @param handle - returns the replacement result, or `undefined` to delegate.
 * @returns a disposer restoring the inherited method.
 */
function wrapMethod(owner, method, handle) {
	const inherited = owner[method];
	owner[method] = function (...args) {
		const replacement = handle(args);
		if (replacement !== undefined) return replacement;
		return inherited.apply(this, args);
	};
	return () => {
		owner[method] = inherited;
	};
}

/** Install the masked view over the filesystem service. */
function hideFromFilesystem(ctx, hidden) {
	const fs = ctx.fs;
	const disposers = [];
	const absent = (target) => hiddenTarget(target, hidden);
	const deny = (args) => (absent(args[0]) ? Promise.reject(notFound(String(args[0]?.displayPath ?? ''))) : undefined);

	disposers.push(wrapMethod(fs, 'stat', (args) => (absent(args[0]) ? Promise.resolve(undefined) : undefined)));
	disposers.push(wrapMethod(fs, 'lstat', (args) => (
		hiddenPath(args[0], args[1]?.cwd, hidden) ? Promise.resolve(undefined) : undefined
	)));
	// A listed directory's entries carry resolved child targets, so children are
	// filtered on the entries themselves; a hidden directory itself is absent.
	const listDir = fs.listDir;
	disposers.push(wrapMethod(fs, 'listDir', (args) => {
		const target = args[0];
		if (absent(target)) return Promise.reject(notFound(String(target?.displayPath ?? '')));
		return listDir.apply(fs, args).then((entries) => entries.filter((entry) => !absent(entry?.target)));
	}));
	for (const method of ['readText', 'streamText', 'readBytes', 'readByteRange', 'writeText', 'editText', 'watch']) {
		disposers.push(wrapMethod(fs, method, deny));
	}
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}

/** Install the masked view over the confined-command provider. */
function hideFromSandbox(ctx, hidden, shadows) {
	const sandbox = ctx.sandbox;
	const confine = sandbox.confine;
	sandbox.confine = async function confineMasked(argv, policy, signal) {
		const prepared = await confine.call(this, argv, policy, signal);
		if (prepared === undefined || !Array.isArray(prepared.argv)) return prepared;
		let mounts;
		try {
			assertHideable(hidden, policy.workspaceRoot);
			refreshShadows(shadows);
			mounts = mountArgs(shadows, policy);
		} catch (error) {
			// The detailed reason names a hidden path, so it stays in the host log.
			ctx.logger.error(`hide-paths: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error('sandbox: path masking is unavailable for this session (the host log holds the reason)');
		}
		if (mounts.length === 0) return prepared;
		const runner = basename(String(prepared.argv[0] ?? ''));
		if (runner !== 'bwrap') {
			ctx.logger.error(`hide-paths: refusing to run under the "${runner}" sandbox backend: name masking needs bubblewrap mount composition`);
			throw new Error('sandbox: path masking requires the bubblewrap backend, which is not the selected runner');
		}
		return { ...prepared, argv: injectMounts(prepared.argv, mounts) };
	};
	return () => {
		sandbox.confine = confine;
	};
}

/** Run the packaged ripgrep inside the same masked view. */
function hideFromRipgrep(ctx, shadows) {
	const subprocess = ctx.subprocess;
	const spawn = subprocess.spawn;
	const profile = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
	subprocess.spawn = function spawnMasked(spec) {
		const argv = spec?.argv;
		if (!Array.isArray(argv) || basename(String(argv[0] ?? '')) !== 'rg') return spawn.call(this, spec);
		let mounts;
		try {
			refreshShadows(shadows);
			mounts = mountArgs(shadows, { mode: 'read-only', workspaceRoot: '/' });
		} catch (error) {
			ctx.logger.error(`hide-paths: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error('sandbox: path masking is unavailable for this search (the host log holds the reason)');
		}
		if (mounts.length === 0) return spawn.call(this, spec);
		return spawn.call(this, { ...spec, argv: ['bwrap', ...profile, ...mounts, '--', ...argv] });
	};
	return () => {
		subprocess.spawn = spawn;
	};
}

/**
 * Activate the bundle. Invalid configuration fails the load instead of
 * degrading to weaker hiding; an empty `hide` list leaves the plugin inert.
 * @param ctx - the host context.
 * @param config - the row config: `hide` paths and an optional `stagingRoot`.
 */
export function apply(ctx, config) {
	const { hide, stagingRoot } = readConfig(config);
	if (hide.length === 0) {
		ctx.logger.info('hide-paths: no paths configured');
		return;
	}
	if (process.platform !== 'linux') {
		throw new Error(`${PLUGIN_NAME}: name masking needs Linux bubblewrap mount composition; ${process.platform} is unsupported`);
	}
	const hidden = resolveHiddenPaths(hide);
	const shadows = buildShadows(hidden, stagingRoot);
	const disposeFilesystem = hideFromFilesystem(ctx, hidden);
	const disposeSandbox = hideFromSandbox(ctx, hidden, shadows);
	const disposeRipgrep = hideFromRipgrep(ctx, shadows);
	ctx.effect(() => () => {
		disposeRipgrep();
		disposeSandbox();
		disposeFilesystem();
		disposeStaging(shadows);
	}, 'hide-paths teardown');
	ctx.logger.info(`hide-paths: masking ${hidden.length} path(s) across ${shadows.length} parent view(s)`);
}
