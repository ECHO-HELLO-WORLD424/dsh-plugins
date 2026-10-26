/**
 * Manual harness for apply(): wires fake services, then checks the composition
 * end to end without touching the live profile. Run with
 * `node test/apply.simulate.js`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const root = mkdtempSync(join(import.meta.dirname, '.tmp-apply-'));
const data = join(root, 'data');
const stagingRoot = join(root, '.staging');
const secret = join(data, 'secret');
const workspace = join(data, 'workspace');
mkdirSync(data, { recursive: true });
mkdirSync(secret, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(secret, 'private.txt'), 'classified');
writeFileSync(join(workspace, 'main.js'), 'export {};');

const calls = { spawn: [] };
const fs = {
  async stat() { return { type: 'file' }; },
  async lstat() { return { type: 'file' }; },
  async listDir() {
    return [
      { name: 'secret', type: 'directory', target: { targetKey: secret, displayPath: secret } },
      { name: 'workspace', type: 'directory', target: { targetKey: workspace, displayPath: workspace } }
    ];
  },
  async readText() { return 'content'; },
  async streamText() { return []; },
  async readBytes() { return new Uint8Array(); },
  async readByteRange() { return new Uint8Array(); },
  async writeText() { return {}; },
  async editText() { return {}; },
  async watch() { return () => {}; }
};
const sandbox = {
  async confine(argv) {
    return { argv: ['bwrap', '--ro-bind', '/', '/', '--proc', '/proc', '--', ...argv], enforcement: 'full' };
  }
};
const subprocess = { spawn(spec) { calls.spawn.push(spec); return { done: Promise.resolve({ exitCode: 0 }) }; } };
const cleanups = [];
const ctx = {
  fs,
  sandbox,
  subprocess,
  logger: { info() {}, warn() {}, error() {} },
  effect(callback, _label) { cleanups.push(callback()); }
};

apply(ctx, { hide: [secret], stagingRoot });

// --- confined commands -----------------------------------------------------
const { argv } = await sandbox.confine(['bash', '-c', 'ls ..'], { mode: 'workspace-write', workspaceRoot: workspace });
console.log('bash argv:', argv.join(' '));
assert.equal(argv.at(-1), 'ls ..');
assert.equal(argv.some((part) => part === secret), false, 'the hidden path never reaches the sandbox argv');
assert.equal(argv.filter((part) => part === '--bind').length, 1, 'the workspace stays read-write');
assert.equal(argv.includes(stagingRoot), false, 'staging is never exposed as a sibling');

// --- file tools ------------------------------------------------------------
assert.equal(await fs.stat({ targetKey: secret, displayPath: secret }), undefined);
assert.equal(await fs.lstat(secret), undefined);
const entries = await fs.listDir({ targetKey: data, displayPath: data });
assert.deepEqual(entries.map((entry) => entry.name), ['workspace']);
await assert.rejects(() => fs.readText({ targetKey: join(secret, 'private.txt'), displayPath: 'private.txt' }), (error) => error.code === 'ENOENT');
await assert.rejects(() => fs.writeText({ targetKey: join(secret, 'new.txt'), displayPath: 'new.txt' }), (error) => error.code === 'ENOENT');
assert.equal(await fs.readText({ targetKey: join(workspace, 'main.js'), displayPath: 'main.js' }), 'content');

// --- search tools ----------------------------------------------------------
subprocess.spawn({ argv: ['/opt/rg', '--files', data], cwd: workspace, stdio: {}, graceMs: 10 });
const rgArgv = calls.spawn[0].argv;
console.log('rg argv:', rgArgv.join(' '));
assert.equal(rgArgv[0], 'bwrap');
assert.equal(rgArgv.includes(secret), false);
assert.equal(rgArgv.at(-1), data);
subprocess.spawn({ argv: ['/usr/bin/git', 'status'], cwd: workspace, stdio: {}, graceMs: 10 });
assert.deepEqual(calls.spawn[1].argv, ['/usr/bin/git', 'status'], 'other spawns are untouched');

// --- teardown --------------------------------------------------------------
for (const cleanup of cleanups.reverse()) cleanup();
assert.deepEqual(await fs.stat({ targetKey: secret, displayPath: secret }), { type: 'file' });
assert.deepEqual(readdirSync(secret), ['private.txt'], 'the real directory is untouched');
assert.deepEqual(readdirSync(stagingRoot), [], 'per-parent staging is removed on teardown');

rmSync(root, { recursive: true, force: true });
console.log('apply simulation OK');
