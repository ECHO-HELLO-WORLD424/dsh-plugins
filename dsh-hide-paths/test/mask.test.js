import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	assertHideable,
	buildShadows,
	disposeStaging,
	hiddenPath,
	hiddenTarget,
	injectMounts,
	mountArgs,
	notFound,
	resolveHiddenPaths,
	under
} from '../lib/mask.js';

const base = mkdtempSync(join(import.meta.dirname, '.tmp-mask-'));
const root = join(base, 'tree');
const staging = join(base, 'staging');
const workspace = join(root, 'workspace');
const secret = join(root, 'secret');
const visible = join(root, 'visible');

mkdirSync(root, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(secret, { recursive: true });
mkdirSync(visible, { recursive: true });
mkdirSync(join(root, 'plain-dir'));
writeFileSync(join(root, 'plain-file.txt'), 'x');
writeFileSync(join(root, 'secret', 'private.txt'), 'classified');
writeFileSync(join(workspace, 'main.js'), 'export {};');

after(() => rmSync(base, { recursive: true, force: true }));

describe('containment', () => {
  it('matches the path itself and every descendant', () => {
    assert.equal(under('/a/b', '/a/b'), true);
    assert.equal(under('/a/b/c', '/a/b'), true);
    assert.equal(under('/a/bc', '/a/b'), false);
    assert.equal(under('/a', '/a/b'), false);
  });
});

describe('configuration', () => {
  it('canonicalizes and folds nested paths into their ancestor', () => {
    const hidden = resolveHiddenPaths([secret, join(secret, 'private.txt'), `${root}/plain-dir`]);
    assert.deepEqual(hidden, [secret, join(root, 'plain-dir')]);
  });

  it('rejects relative, root, and unmaskable paths', () => {
    assert.throws(() => resolveHiddenPaths(['relative/path']), /must be absolute/u);
    assert.throws(() => resolveHiddenPaths(['/']), /refusing to hide "\/"/u);
    assert.throws(() => resolveHiddenPaths(['/tmp/anything']), /not maskable/u);
    assert.throws(() => resolveHiddenPaths(['/proc/self']), /not maskable/u);
  });

  it('refuses a hidden tree that overlaps the workspace', () => {
    assert.throws(() => assertHideable([secret], root), /workspace/u);
    assert.throws(() => assertHideable([root], workspace), /inside it/u);
    assert.doesNotThrow(() => assertHideable([secret], workspace));
  });
});

describe('mount composition', () => {
  const hidden = resolveHiddenPaths([secret]);
  const shadows = buildShadows(hidden, staging);

  after(() => disposeStaging(shadows));

  it('stages every visible sibling but never the hidden name', () => {
    const args = mountArgs(shadows, { mode: 'read-only', workspaceRoot: workspace });
    assert.equal(args[0], '--ro-bind');
    assert.equal(args[1], shadows[0].stage);
    assert.equal(args[2], root);
    assert.equal(args.includes(secret), false);
    assert.equal(args.includes(join(root, 'plain-file.txt')), true);
  });

  it('binds a workspace below a shadowed parent read-write last', () => {
    const direct = mountArgs(shadows, { mode: 'workspace-write', workspaceRoot: workspace });
    const at = direct.indexOf(workspace);
    assert.equal(direct[at - 1], '--bind');

    const nested = join(root, 'nested', 'app');
    mkdirSync(nested, { recursive: true });
    const args = mountArgs(shadows, { mode: 'workspace-write', workspaceRoot: nested });
    assert.deepEqual(args.slice(-3), ['--bind', nested, nested]);
  });

  it('never widens a read-only policy', () => {
    const args = mountArgs(shadows, { mode: 'read-only', workspaceRoot: workspace });
    assert.equal(args.includes('--bind'), false);
  });

  it('injects before the runner separator and leaves other argv untouched', () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', 'ls'];
    const composed = injectMounts(argv, ['--ro-bind', '/stage', '/parent']);
    assert.deepEqual(composed, ['bwrap', '--ro-bind', '/', '/', '--ro-bind', '/stage', '/parent', '--', 'bash', '-c', 'ls']);
    assert.equal(injectMounts(argv, []), argv);
  });
});

describe('observation', () => {
  const hidden = resolveHiddenPaths([secret]);

  it('reports hidden targets and paths as absent', () => {
    assert.equal(hiddenTarget({ targetKey: secret, displayPath: secret }, hidden), true);
    assert.equal(hiddenTarget({ targetKey: join(secret, 'private.txt'), displayPath: 'x' }, hidden), true);
    assert.equal(hiddenTarget({ targetKey: visible, displayPath: visible }, hidden), false);
    assert.equal(hiddenPath(join(secret, 'private.txt'), root, hidden), true);
    assert.equal(hiddenPath('visible', root, hidden), false);
  });

  it('shapes a missing-file error, never a denial', () => {
    const error = notFound('/x/y');
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /^ENOENT: no such file or directory/u);
  });
});
