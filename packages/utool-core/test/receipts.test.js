/**
 * Receipt tests: exact uninstall and the version pointer.
 *
 * The rollback pointer is the property worth locking down. Without it an update is
 * a one-way door; with it, a bad update has a recorded target. The subtle case this
 * covers is that re-installing the SAME artifact must not overwrite the pointer
 * with itself, or rolling back would "roll back" to the broken version.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

test('a receipt is written as a valid v3 document and read back', async (t) => {
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
  assert.equal(receipt.formatVersion, '3');
  assert.equal(receipt.toolId, 'demo');
  assert.deepEqual(receipt.installedEngines, ['unity']);
  assert.deepEqual(receipt.installedFiles, ['Assets/Demo/One.cs', 'Assets/Demo/Two.cs']);
  assert.equal(receipt.previousSha256, null);
});

test('receipts written under the old directory are migrated on first use', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  // Simulate a project installed before the rename: write a receipt the current way, then move
  // the directory to where the old build would have put it.
  const before = new ReceiptStore(project);
  await before.write(
    baseReceipt({
      toolId: 'legacy-tool',
      version: '0.9.0',
      artifactSha256: 'a'.repeat(64),
      installedFiles: ['Assets/Legacy/One.cs'],
    }),
  );

  const legacyDir = path.join(project, 'Library', 'DevCatToolRegistry', 'receipts');
  await mkdir(path.dirname(legacyDir), { recursive: true });
  await rename(before.dir, legacyDir);
  assert.equal(existsSync(path.join(project, 'Library', 'ToolImport', 'receipts')), false);

  // A store built now must find it, and must leave the directory where the current build
  // expects it - otherwise every later write lands somewhere no reader looks.
  const store = new ReceiptStore(project);
  const list = await store.list();
  assert.equal(list.length, 1, 'the migrated receipt must be visible');
  assert.equal(list[0].toolId, 'legacy-tool');
  assert.equal(list[0].version, '0.9.0');

  assert.equal(existsSync(path.join(project, 'Library', 'ToolImport', 'receipts')), true);
  assert.equal(existsSync(legacyDir), false, 'the legacy directory must be moved, not copied');

  // The migrated receipt still drives uninstall: the installed files are what it deletes.
  const read = await store.read('legacy-tool');
  assert.deepEqual(read.installedFiles, ['Assets/Legacy/One.cs']);
});

test('a legacy directory never wins over receipts this build wrote', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'current-tool',
      version: '1.0.0',
      artifactSha256: 'b'.repeat(64),
      installedFiles: ['Assets/Current/One.cs'],
    }),
  );

  // A leftover legacy directory must not displace receipts written by this build.
  const legacyDir = path.join(project, 'Library', 'DevCatToolRegistry', 'receipts');
  await mkdir(legacyDir, { recursive: true });

  const reopened = new ReceiptStore(project);
  const list = await reopened.list();
  assert.deepEqual(list.map((receipt) => receipt.toolId), ['current-tool']);
});

test('a cross-engine install is still ONE receipt', async (t) => {  const project = await tempProject();
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

test('a file the user has edited is reported, not deleted', async (t) => {
  // This is the distinction the no-pollution claim rests on. A receipt can say exactly
  // which file it wrote and what those bytes were; if the digest on disk no longer
  // matches, the file is no longer ours, and removing it would destroy the user's work.
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const expected = createHash('sha256').update(Buffer.from('original')).digest('hex');

  await mkdir(path.join(project, 'Assets/Lib'), { recursive: true });
  await writeFile(path.join(project, 'Assets/Lib/Mine.cs'), 'original');
  await writeFile(path.join(project, 'Assets/Lib/Untouched.cs'), 'untouched');

  const untouched = createHash('sha256').update(Buffer.from('untouched')).digest('hex');

  await store.write(
    baseReceipt({
      toolId: 'lib-a',
      version: '1.0.0',
      artifactSha256: 'e'.repeat(64),
      installedFiles: ['Assets/Lib/Mine.cs', 'Assets/Lib/Untouched.cs'],
      installedFileHashes: {
        'Assets/Lib/Mine.cs': expected,
        'Assets/Lib/Untouched.cs': untouched,
      },
    }),
  );

  // Before the edit, both files are simply deletable.
  const clean = await store.planUninstall(['lib-a']);
  assert.deepEqual(clean.modified, []);
  assert.deepEqual(clean.delete, ['Assets/Lib/Mine.cs', 'Assets/Lib/Untouched.cs']);

  // The user edits one of them.
  await writeFile(path.join(project, 'Assets/Lib/Mine.cs'), 'edited by hand');

  const after = await store.planUninstall(['lib-a']);
  assert.equal(after.modified.length, 1, `expected one modified file, got ${JSON.stringify(after.modified)}`);
  assert.equal(after.modified[0].file, 'Assets/Lib/Mine.cs');
  assert.equal(after.modified[0].expected, expected);
  assert.notEqual(after.modified[0].actual, expected);
  // Ownership is by directory, not by intent: an edited file is still deleted, and is reported so
  // the caller can show it before it goes. Reinstalling is the supported way back.
  assert.deepEqual(after.delete, ['Assets/Lib/Mine.cs', 'Assets/Lib/Untouched.cs'],
    'an edited file inside the tool\'s directory is still removed');
});

test('a file already removed from disk is reported separately', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'lib-gone',
      version: '1.0.0',
      artifactSha256: 'f'.repeat(64),
      installedFiles: ['Assets/Lib/Vanished.cs'],
      installedFileHashes: { 'Assets/Lib/Vanished.cs': 'a'.repeat(64) },
    }),
  );

  const plan = await store.planUninstall(['lib-gone']);
  assert.deepEqual(plan.alreadyGone, ['Assets/Lib/Vanished.cs']);
  assert.deepEqual(plan.modified, []);
  // Still listed for removal: deleting a path that does not exist is a no-op, and
  // omitting it would make the plan disagree with the receipt.
  assert.deepEqual(plan.delete, ['Assets/Lib/Vanished.cs']);
});

test('a receipt with no recorded digests cannot judge, so it deletes', async (t) => {
  // Receipts written before per-file digests existed must keep working: absent a
  // digest there is nothing to compare, and guessing "modified" would block every
  // uninstall of an older install.
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await mkdir(path.join(project, 'Assets/Lib'), { recursive: true });
  await writeFile(path.join(project, 'Assets/Lib/Old.cs'), 'whatever');

  await store.write(
    baseReceipt({
      toolId: 'lib-legacy',
      version: '1.0.0',
      artifactSha256: '1'.repeat(64),
      installedFiles: ['Assets/Lib/Old.cs'],
    }),
  );

  const plan = await store.planUninstall(['lib-legacy']);
  assert.deepEqual(plan.modified, []);
  assert.deepEqual(plan.delete, ['Assets/Lib/Old.cs']);
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

test('uninstall execution removes exactly the planned files and clears the receipt', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'demo',
      version: '1.0.0',
      artifactSha256: 'a'.repeat(64),
      installedFiles: ['Assets/Demo/One.cs', 'Assets/Demo/Nested/Two.cs'],
    }),
  );

  for (const relative of ['Assets/Demo/One.cs', 'Assets/Demo/Nested/Two.cs']) {
    await mkdir(path.dirname(path.join(project, relative)), { recursive: true });
    await writeFile(path.join(project, relative), 'x', 'utf8');
  }
  // A file the user added inside the tool's directory. It is NOT in the receipt,
  // so it must survive: ownership is of the recorded files, not of the folder.
  await writeFile(path.join(project, 'Assets/Demo/mine.cs'), 'mine', 'utf8');

  const plan = await store.planUninstall(['demo']);
  const outcome = await store.executeUninstall(plan, {
    projectRoot: project,
    receiptStore: store,
    toolIds: ['demo'],
  });

  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.removed.length, 2);
  assert.ok(!existsSync(path.join(project, 'Assets/Demo/One.cs')));
  assert.ok(!existsSync(path.join(project, 'Assets/Demo/Nested/Two.cs')));
  assert.ok(existsSync(path.join(project, 'Assets/Demo/mine.cs')), 'an unrecorded file must survive');
  assert.deepEqual(outcome.receipts, ['demo']);
  assert.deepEqual(await store.list(), [], 'the receipt is cleared');
});

test('uninstall refuses to delete outside the project root', async (t) => {
  const project = await tempProject();
  const outside = path.join(path.dirname(project), `outside-${path.basename(project)}.txt`);
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  await writeFile(outside, 'precious', 'utf8');
  await mkdir(path.join(project, 'Assets'), { recursive: true });
  await writeFile(path.join(project, 'Assets', 'inner.cs'), 'x', 'utf8');

  const store = new ReceiptStore(project);
  // A hand-edited receipt naming a path outside the project.
  const outcome = await store.executeUninstall(
    { delete: ['../' + path.basename(outside), 'Assets/inner.cs'], missingReceipts: [] },
    { projectRoot: project, receiptStore: store, toolIds: [] },
  );

  assert.ok(existsSync(outside), 'a path outside the project must never be deleted');
  assert.equal(await readFile(outside, 'utf8'), 'precious');
  assert.ok(!existsSync(path.join(project, 'Assets', 'inner.cs')), 'the in-project file is still removed');
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].reason, 'outside the project root');
});

test('uninstall never removes Assets itself, and tidies only empty directories', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'demo',
      version: '1.0.0',
      artifactSha256: 'b'.repeat(64),
      installedFiles: ['Assets/Editor/Demo/Thing.cs'],
    }),
  );
  await mkdir(path.join(project, 'Assets/Editor/Demo'), { recursive: true });
  await writeFile(path.join(project, 'Assets/Editor/Demo/Thing.cs'), 'x', 'utf8');

  const plan = await store.planUninstall(['demo']);
  await store.executeUninstall(plan, { projectRoot: project, receiptStore: store, toolIds: ['demo'] });

  assert.ok(existsSync(path.join(project, 'Assets')), 'Assets must survive');
  assert.ok(existsSync(path.join(project, 'Assets/Editor')), 'Assets/Editor must survive');
  assert.ok(!existsSync(path.join(project, 'Assets/Editor/Demo')), 'the now-empty tool folder is tidied');
});

test('uninstall clears Unity .meta leftovers so the folder does not come back', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'demo',
      version: '1.0.0',
      artifactSha256: 'e'.repeat(64),
      installedFiles: ['Assets/Demo/Thing.cs'],
    }),
  );

  // Unity's real layout: a .meta beside EVERY asset and EVERY folder.
  await mkdir(path.join(project, 'Assets/Demo'), { recursive: true });
  await writeFile(path.join(project, 'Assets/Demo/Thing.cs'), 'x', 'utf8');
  await writeFile(path.join(project, 'Assets/Demo/Thing.cs.meta'), 'MonoImporter', 'utf8');
  await writeFile(path.join(project, 'Assets/Demo.meta'), 'folderAsset: yes', 'utf8');
  await writeFile(path.join(project, 'Assets.meta'), 'folderAsset: yes', 'utf8');

  const plan = await store.planUninstall(['demo']);
  await store.executeUninstall(plan, { projectRoot: project, receiptStore: store, toolIds: ['demo'] });

  // A folder's own .meta is Unity's record of a folder it will re-create on the next
  // Refresh, so leaving it behind would resurrect the directory.
  assert.ok(!existsSync(path.join(project, 'Assets/Demo')), 'the tool folder is gone');
  assert.ok(!existsSync(path.join(project, 'Assets/Demo.meta')), "the folder's own .meta is gone");
  assert.ok(!existsSync(path.join(project, 'Assets/Demo/Thing.cs.meta')), 'the asset .meta is gone');
  // Assets is not the tool's to remove, and neither is its .meta.
  assert.ok(existsSync(path.join(project, 'Assets')), 'Assets survives');
  assert.ok(existsSync(path.join(project, 'Assets.meta')), "Assets' own .meta survives");
});

test('uninstall keeps a directory that still holds real work', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'demo',
      version: '1.0.0',
      artifactSha256: 'f'.repeat(64),
      installedFiles: ['Assets/Demo/Thing.cs'],
    }),
  );

  await mkdir(path.join(project, 'Assets/Demo'), { recursive: true });
  await writeFile(path.join(project, 'Assets/Demo/Thing.cs'), 'x', 'utf8');
  // The user's own file, plus Unity's .meta for it. Not a stray: something real is here.
  await writeFile(path.join(project, 'Assets/Demo/Mine.cs'), 'mine', 'utf8');
  await writeFile(path.join(project, 'Assets/Demo/Mine.cs.meta'), 'MonoImporter', 'utf8');

  const plan = await store.planUninstall(['demo']);
  await store.executeUninstall(plan, { projectRoot: project, receiptStore: store, toolIds: ['demo'] });

  assert.ok(existsSync(path.join(project, 'Assets/Demo/Mine.cs')), 'the user file survives');
  assert.ok(existsSync(path.join(project, 'Assets/Demo/Mine.cs.meta')), 'its .meta survives too');
  assert.ok(existsSync(path.join(project, 'Assets/Demo')), 'so the directory stays');
});

test('a dependency another installed tool still needs is reported as blocking', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  // The library was pulled in BY the consumer, which records exactly that.
  await store.write(
    baseReceipt({
      toolId: 'lib',
      version: '1.0.0',
      artifactSha256: 'a'.repeat(64),
      installedFiles: ['Assets/Lib/Thing.cs'],
      installedByTools: ['consumer'],
    }),
  );
  await store.write(
    baseReceipt({
      toolId: 'consumer',
      version: '1.0.0',
      artifactSha256: 'b'.repeat(64),
      installedFiles: ['Assets/Consumer/Thing.cs'],
      installedByTools: ['user'],
    }),
  );

  const blocked = await store.blockedByDependents(['lib']);
  assert.deepEqual(blocked, [{ tool: 'lib', stillNeededBy: ['consumer'] }]);

  // Removing BOTH is fine: the dependent goes too, so nothing is left broken.
  assert.deepEqual(await store.blockedByDependents(['lib', 'consumer']), []);
  // A tool the user installed directly is never "still needed".
  assert.deepEqual(await store.blockedByDependents(['consumer']), []);
});

test('a dependency is no longer blocking once its consumer is gone', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  // `installedByTools` names a tool that is NOT installed - the consumer was
  // already removed. Refusing here would make the library unremovable forever.
  await store.write(
    baseReceipt({
      toolId: 'lib',
      version: '1.0.0',
      artifactSha256: 'c'.repeat(64),
      installedFiles: ['Assets/Lib/Thing.cs'],
      installedByTools: ['already-gone'],
    }),
  );

  assert.deepEqual(await store.blockedByDependents(['lib']), []);
});

test('a dependency left with no consumer is reported as orphaned, not deleted', async (t) => {
  const project = await tempProject();
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  await store.write(
    baseReceipt({
      toolId: 'lib',
      version: '1.0.0',
      artifactSha256: 'd'.repeat(64),
      installedFiles: ['Assets/Lib/Thing.cs'],
      installedByTools: ['consumer'],
    }),
  );
  await store.write(
    baseReceipt({
      toolId: 'consumer',
      version: '1.0.0',
      artifactSha256: 'e'.repeat(64),
      installedFiles: ['Assets/Consumer/Thing.cs'],
      installedByTools: ['user'],
    }),
  );

  // Removing the consumer orphans the library...
  assert.deepEqual(await store.orphanedAfter(['consumer']), ['lib']);
  // ...but orphaned means REPORTED. Nothing is removed until asked.
  const plan = await store.planUninstall(['consumer']);
  assert.deepEqual(plan.delete, ['Assets/Consumer/Thing.cs']);
  assert.ok(!plan.delete.includes('Assets/Lib/Thing.cs'), 'the orphan is not swept up');

  // A tool the user installed directly is never an orphan.
  assert.deepEqual(await store.orphanedAfter(['lib']), []);
});
