/**
 * dsh-gpu-patch — grant the host NVIDIA device nodes to confined commands.
 *
 * DSH's Linux sandbox profile starts with `--dev /dev`, which installs a FRESH
 * minimal device tree (null, zero, full, random, urandom, tty, pts, shm). The
 * NVIDIA nodes are therefore absent inside the sandbox, so CUDA's read-write
 * open of /dev/nvidiactl + /dev/nvidia0 fails with CUDA_ERROR_NO_DEVICE and
 * frameworks such as JAX quietly fall back to the CPU backend.
 *
 * The provider has no policy vocabulary for device grants, but `confine` is an
 * ordinary service method: this plugin wraps it and appends `--dev-bind` for
 * every GPU node that actually exists on the host. Bubblewrap resolves a bind
 * SOURCE against the host view, so binding after `--dev /dev` recreates the
 * nodes in the sandbox's fresh device tree.
 *
 * Wrapping at runtime (instead of patching the installed package) keeps the
 * grant across DSH updates and applies without a restart.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';

/** Plugin name used in log lines and thrown errors. */
export const name = 'dsh-gpu-patch';

/** The sandbox service is wrapped, so activation waits for it. */
export const inject = ['sandbox'];

/**
 * Device nodes CUDA/NVML needs. `/dev/nvidia-caps` only matters for MIG, but it
 * is bound when present so capability queries do not fail on MIG hosts.
 * Numbered nodes (`/dev/nvidia0`, `/dev/nvidia1`, …) are discovered from /dev
 * so multi-GPU hosts need no configuration.
 */
const BASE_NODES = [
	'/dev/nvidiactl',
	'/dev/nvidia-uvm',
	'/dev/nvidia-uvm-tools',
	'/dev/nvidia-modeset',
	'/dev/nvidia-caps',
];

/** Warning is worth one log line, not one per command. */
const warnOnce = (ctx, message) => {
	let warned = false;
	return () => {
		if (warned) return;
		warned = true;
		ctx.logger.warn(message);
	};
};

/**
 * Read the row config. The plugin deliberately exports no `Config` schema: a
 * workspace-linked bundle cannot resolve the harness's schema package
 * (`@deepseek-ai/schemastery`), so the config is validated here and an invalid
 * entry fails the load instead of silently granting the wrong devices.
 * @param config - the row config.
 * @returns extra absolute device paths to bind on top of the discovered ones.
 */
function readConfig(config) {
	const extraNodes = config?.extraNodes;
	if (extraNodes === undefined) return [];
	if (!Array.isArray(extraNodes)) {
		throw new Error(`${name}: "extraNodes" must be a list of absolute device paths`);
	}
	for (const node of extraNodes) {
		if (typeof node !== 'string' || !node.startsWith('/')) {
			throw new Error(`${name}: every "extraNodes" entry must be an absolute path`);
		}
	}
	return extraNodes;
}

/**
 * The GPU device nodes present on the host, deduplicated and only those that
 * exist: bubblewrap aborts on a missing bind source, so absence must be
 * resolved here rather than inside the profile.
 * @param extraNodes - configured paths to bind in addition to the defaults.
 * @returns absolute existing device paths.
 */
function presentGpuNodes(extraNodes) {
	const candidates = new Set(BASE_NODES);
	// Numbered device nodes are per-GPU, so they cannot live in a fixed list.
	try {
		for (const entry of readdirSync('/dev')) {
			if (/^nvidia\d+$/u.test(entry)) candidates.add(`/dev/${entry}`);
		}
	} catch {
		// /dev unreadable: fall back to the fixed names, which still cover the
		// non-numbered nodes CUDA opens.
	}
	for (const node of extraNodes) candidates.add(node);
	return [...candidates].filter((node) => existsSync(node)).sort();
}

/**
 * Insert runner arguments before the `--` separator that ends the bubblewrap
 * profile and starts the confined command.
 * @param argv - the confined argv.
 * @param extra - arguments to add to the profile.
 * @returns a new argv with `extra` appended to the profile.
 */
function injectBeforeCommand(argv, extra) {
	const separator = argv.indexOf('--');
	if (separator < 1) return undefined;
	return [...argv.slice(0, separator), ...extra, ...argv.slice(separator)];
}

/**
 * Install the device grant over the confined-command provider.
 * @param ctx - the host context holding the sandbox service.
 * @param extraNodes - configured device paths to bind as well.
 * @returns a disposer restoring the inherited method.
 */
function grantDevices(ctx, extraNodes) {
	const sandbox = ctx.sandbox;
	const confine = sandbox.confine;
	const warnBackend = warnOnce(ctx, `${name}: the selected sandbox backend is not bubblewrap, so the GPU device nodes stay hidden in this session`);
	const warnSeparator = warnOnce(ctx, `${name}: the confined argv has no runner separator; the GPU device nodes stay hidden for this command`);

	sandbox.confine = async function confineWithDevices(argv, policy, signal) {
		const prepared = await confine.call(this, argv, policy, signal);
		if (policy?.mode !== 'workspace-write') return prepared;
		const confined = prepared?.argv;
		if (!Array.isArray(confined)) return prepared;
		if (basename(String(confined[0] ?? '')) !== 'bwrap') {
			warnBackend();
			return prepared;
		}
		// A provider patched out of band (legacy/apply.sh) already binds the
		// nodes; binding them twice would only add redundant mounts.
		if (confined.includes('--dev-bind')) return prepared;
		const nodes = presentGpuNodes(extraNodes);
		if (nodes.length === 0) return prepared;
		const injected = injectBeforeCommand(confined, nodes.flatMap((node) => ['--dev-bind', node, node]));
		if (injected === undefined) {
			warnSeparator();
			return prepared;
		}
		return { ...prepared, argv: injected };
	};

	return () => {
		sandbox.confine = confine;
	};
}

/**
 * Activate the bundle.
 * @param ctx - the host context.
 * @param config - the row config: optional `extraNodes`.
 */
export function apply(ctx, config) {
	const extraNodes = readConfig(config);
	if (process.platform !== 'linux') {
		ctx.logger.info(`${name}: not Linux, so no device bind is needed`);
		return;
	}
	const dispose = grantDevices(ctx, extraNodes);
	ctx.effect(() => dispose, 'gpu-patch teardown');
	const nodes = presentGpuNodes(extraNodes);
	ctx.logger.info(nodes.length === 0
		? `${name}: no NVIDIA device node on this host; confined sessions keep the CPU`
		: `${name}: granting ${nodes.join(', ')} to workspace-write sessions`);
}
