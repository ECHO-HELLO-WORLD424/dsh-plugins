/**
 * Behavioural tests for the confine composition.
 *
 * The plugin runs in the unconfined host process, so these tests replace the
 * provider and use `/dev/null` as a device node that exists in every sandbox:
 * the point is where the `--dev-bind` pairs land in the bubblewrap argv, not
 * which devices this machine has.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

const PROFILE = [
	'--ro-bind', '/', '/',
	'--dev', '/dev',
	'--unshare-pid',
	'--proc', '/proc',
	'--die-with-parent',
];

const WORKSPACE_WRITE = { mode: 'workspace-write', workspaceRoot: '/ws' };
const READ_ONLY = { mode: 'read-only', workspaceRoot: '/ws' };

/**
 * A provider whose confined argv has the profile/command separator.
 * @param options - runner to pretend was selected, and profile args a patched provider already adds.
 */
function harness({ runner = 'bwrap', prefixArgs = [] } = {}) {
	const events = [];
	const disposers = [];
	const sandbox = {
		confine: async (argv) => ({
			argv: [runner, ...PROFILE, ...prefixArgs, '--tmpfs', '/tmp', '--bind', '/ws', '/ws', '--', ...argv],
			enforcement: 'full',
			denialSignatures: [],
			runnerFailureRules: [],
		}),
	};
	const ctx = {
		sandbox,
		logger: {
			info: (message) => events.push(['info', message]),
			warn: (message) => events.push(['warn', message]),
		},
		effect: (register) => {
			disposers.push(register());
		},
	};
	apply(ctx, { extraNodes: ['/dev/null'] });
	return { ctx, sandbox, events, dispose: () => disposers.forEach((dispose) => dispose()) };
}

test('workspace-write sessions bind the device nodes before the separator', async () => {
	const { sandbox } = harness();
	const { argv } = await sandbox.confine(['bash', '-c', 'nvidia-smi'], WORKSPACE_WRITE);

	const binds = argv.indexOf('--dev-bind');
	const separator = argv.indexOf('--');
	assert.notEqual(binds, -1, 'no device bind was injected');
	assert.ok(binds < separator, 'the device bind must be part of the profile');
	assert.deepEqual(argv.slice(binds, binds + 3), ['--dev-bind', '/dev/null', '/dev/null']);
	assert.deepEqual(argv.slice(separator + 1), ['bash', '-c', 'nvidia-smi'], 'the confined command must follow the separator');
});

test('the device bind follows the fresh device tree that hides it', async () => {
	const { sandbox } = harness();
	const { argv } = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);
	assert.ok(argv.indexOf('/dev') < argv.indexOf('--dev-bind'), 'binding must come after --dev /dev');
});

test('read-only sessions are untouched', async () => {
	const { sandbox, events } = harness();
	const { argv } = await sandbox.confine(['bash', '-c', 'true'], READ_ONLY);
	assert.equal(argv.includes('--dev-bind'), false);
	assert.equal(events.filter(([level]) => level === 'warn').length, 0);
});

test('a non-bubblewrap backend warns once instead of injecting', async () => {
	const { sandbox, events } = harness({ runner: 'landlock-run' });

	const first = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);
	const second = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);

	assert.equal(first.argv.includes('--dev-bind'), false);
	assert.equal(second.argv.includes('--dev-bind'), false);
	assert.equal(events.filter(([level]) => level === 'warn').length, 1);
});

test('a provider that already binds the nodes is not patched twice', async () => {
	const { sandbox } = harness({ prefixArgs: ['--dev-bind', '/dev/null', '/dev/null'] });
	const { argv } = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);
	assert.equal(argv.filter((argument) => argument === '--dev-bind').length, 1);
});

test('the disposer restores the inherited method', async () => {
	const { sandbox, dispose } = harness();
	const wrapped = sandbox.confine;
	const injected = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);
	assert.equal(injected.argv.includes('--dev-bind'), true);

	dispose();

	assert.notEqual(sandbox.confine, wrapped, 'expected the wrapper to be removed');
	const inherited = await sandbox.confine(['bash', '-c', 'true'], WORKSPACE_WRITE);
	assert.equal(inherited.argv.includes('--dev-bind'), false);
});
