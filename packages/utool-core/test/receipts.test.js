/**
 * Receipt tests: exact uninstall and the version pointer.
 *
 * The rollback pointer is the property worth locking down. Without it an update is
 * a one-way door; with it, a bad update has a recorded target. The subtle case this
 * covers is that re-installing the SAME artifact must not overwrite the pointer
 * with itself, or rolling back would "roll back" to the broken version.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ReceiptStore } from '../src/index.js';

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'utool-receipts-'));
}

function baseReceipt(overrides) {
  return {
    artifactFormat: 'unitypackage',
    installedAtUtc: '2026-01-01T00:00:00Z',
    registryRef: null,
    registryCommit: null,
    installedEngines: ['unity'],
    installedByTools: ['user'],
    ...overrides,
  };
}

test('a receipt is written as a valid v2 document and read back', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'demo',
      version: '1.0.0',
      artifactSha256: 'a'.repeat(64),
      installedFiles: ['Assets/Demo/One.cs', 'Assets/Demo/Two.cs'],
    }),
  );

  const receipt = await store.read('demo');
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.formatVersion, '2');
  assert.equal(receipt.toolId, 'demo');
  assert.deepEqual(receipt.installedEngines, ['unity']);
  assert.deepEqual(receipt.installedFiles, ['Assets/Demo/One.cs', 'Assets/Demo/Two.cs']);
  assert.equal(receipt.previousSha256, null);
});

test('a cross-engine install is still ONE receipt', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'cross',
      version: '1.0.0',
      artifactSha256: 'b'.repeat(64),
      installedEngines: ['unity', 'godot'],
      installedFiles: ['Assets/X.cs', 'addons/x/plugin.cfg'],
    }),
  );

  const receipts = await store.list();
  assert.equal(receipts.length, 1, 'one install action means one receipt, whatever engines it touched');
  assert.deepEqual(receipts[0].installedEngines, ['godot', 'unity']);
});

test('shared files survive until the last claimant leaves', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'lib-a',
      version: '1.0.0',
      artifactSha256: 'c'.repeat(64),
      installedFiles: ['Assets/Shared/Common.cs', 'Assets/LibA/Only.cs'],
    }),
  );
  await store.write(
    baseReceipt({
      toolId: 'lib-b',
      version: '1.0.0',
      artifactSha256: 'd'.repeat(64),
      installedFiles: ['Assets/Shared/Common.cs', 'Assets/LibB/Only.cs'],
    }),
  );

  assert.deepEqual(await store.claimantsOf('Assets/Shared/Common.cs'), ['lib-a', 'lib-b']);

  const one = await store.planUninstall(['lib-a']);
  assert.deepEqual(one.delete, ['Assets/LibA/Only.cs']);
  assert.deepEqual(one.keep, [{ file: 'Assets/Shared/Common.cs', claimedBy: ['lib-b'] }]);

  const both = await store.planUninstall(['lib-a', 'lib-b']);
  assert.deepEqual(both.delete, ['Assets/LibA/Only.cs', 'Assets/LibB/Only.cs', 'Assets/Shared/Common.cs']);
  assert.deepEqual(both.keep, []);
});

// ---------------------------------------------------------------------------
// the version pointer
// ---------------------------------------------------------------------------

test('updating a tool records what it replaced', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const OLD = '1'.repeat(64);
  const NEW = '2'.repeat(64);

  await store.write(
    baseReceipt({ toolId: 'demo', version: '1.0.0', artifactSha256: OLD, installedFiles: ['Assets/A.cs'] }),
  );
  const first = await store.read('demo');
  assert.equal(first.previousSha256, null, 'a fresh install has nothing to roll back to');

  await store.write(
    baseReceipt({ toolId: 'demo', version: '2.0.0', artifactSha256: NEW, installedFiles: ['Assets/A.cs'] }),
  );
  const second = await store.read('demo');
  assert.equal(second.previousSha256, OLD, 'the update must remember the artifact it replaced');

  const rollback = await store.planRollback('demo');
  assert.equal(rollback.ok, true);
  assert.equal(rollback.from, NEW);
  assert.equal(rollback.to, OLD);
});

test('re-installing the same artifact must NOT overwrite the pointer with itself', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const OLD = '1'.repeat(64);
  const NEW = '2'.repeat(64);

  await store.write(baseReceipt({ toolId: 'demo', version: '1.0.0', artifactSha256: OLD, installedFiles: [] }));
  await store.write(baseReceipt({ toolId: 'demo', version: '2.0.0', artifactSha256: NEW, installedFiles: [] }));

  // The same artifact installed again. If the pointer were refreshed blindly it
  // would become NEW, and rolling back would restore the broken version.
  await store.write(baseReceipt({ toolId: 'demo', version: '2.0.0', artifactSha256: NEW, installedFiles: [] }));

  const receipt = await store.read('demo');
  assert.equal(receipt.previousSha256, OLD, 'a reinstall of the same bytes must keep the original target');
});

test('a tool with no previous version reports that rollback is impossible', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({ toolId: 'fresh', version: '1.0.0', artifactSha256: 'e'.repeat(64), installedFiles: [] }),
  );

  const rollback = await store.planRollback('fresh');
  assert.equal(rollback.ok, false);
  assert.match(rollback.reason, /no previous version recorded/);
});

test('rollback of an unknown tool says so instead of throwing', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const rollback = await store.planRollback('never-installed');
  assert.equal(rollback.ok, false);
  assert.match(rollback.reason, /no receipt/);
});

test('clearing the pointer makes the same rollback unavailable twice', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({ toolId: 'demo', version: '1.0.0', artifactSha256: '1'.repeat(64), installedFiles: [] }),
  );
  await store.write(
    baseReceipt({ toolId: 'demo', version: '2.0.0', artifactSha256: '2'.repeat(64), installedFiles: [] }),
  );
  assert.equal((await store.planRollback('demo')).ok, true);

  await store.clearRollback('demo');
  const after = await store.planRollback('demo');
  assert.equal(after.ok, false, 'after rolling back, the same broken version must not be offered again');
});

test('a summary groups installs by artifact digest', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const digest = 'f'.repeat(64);
  await store.write(baseReceipt({ toolId: 'one', version: '1.0.0', artifactSha256: digest, installedFiles: ['a'] }));
  await store.write(baseReceipt({ toolId: 'two', version: '1.0.0', artifactSha256: digest, installedFiles: ['b'] }));

  const summary = await store.summary();
  assert.equal(summary.totalTools, 2);
  assert.equal(summary.totalFiles, 2);
  assert.deepEqual(summary.byDigest.get(digest), ['one', 'two']);
});
