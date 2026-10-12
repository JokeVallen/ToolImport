/**
 * Tests for registry validation, resolution, artifact verification and install.
 *
 * The bug these tests were written to lock down: an artifact named
 * `<id>-1.0.0.evil.zip` used to PASS validation, because the path regex let the
 * extension match a later dot in the name. A wrongly-accepted name means the
 * import tool would happily install something whose identity does not match its
 * bytes' declared name, so this is a correctness issue, not cosmetics.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';

import {
  ARTIFACT_FORMAT,
  EXIT,
  LocalRegistrySource,
  ReceiptStore,
  buildIndex,
  executeInstall,
  extractUnitypackage,
  isConformingArtifactName,
  parseUtool,
  planInstallation,
  resolveSelection,
  toManifest,
  validateRegistry,
  verifyArtifactBytes,
} from '../src/index.js';
import { REGISTRY } from './format.test.js';

// ---------------------------------------------------------------------------
// helpers: build tiny synthetic registries
// ---------------------------------------------------------------------------

/** Build a minimal but structurally valid .unitypackage (gzipped tar). */
function makeUnitypackage(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    const body = Buffer.from(data, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8'); // mode
    header.write('0000000\0', 108, 8, 'utf8'); // uid
    header.write('0000000\0', 116, 8, 'utf8'); // gid
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8'); // mtime
    header.write('        ', 148, 8, 'utf8'); // checksum (not verified by our reader)
    header.write('0', 156, 1, 'utf8'); // typeflag: regular file
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return gzipSync(Buffer.concat(blocks));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Create a registry with one bundled tool. `nameOverride` lets a test give the
 * artifact a non-conforming file name.
 */
async function makeRegistry(root, options = {}) {
  const id = options.id ?? 'demo-tool';
  const version = options.version ?? '1.0.0';
  const format = options.format ?? ARTIFACT_FORMAT.UNITYPACKAGE;

  const pkg = makeUnitypackage([
    { name: 'aaa/pathname', data: `Assets/${id}/Demo.cs` },
    { name: 'aaa/asset', data: 'public class Demo {}' },
    { name: 'aaa/asset.meta', data: 'fileFormatVersion: 2' },
  ]);

  const dirName = `payloads/${id}`;
  await mkdir(path.join(root, dirName, 'artifacts'), { recursive: true });

  const fileName = options.nameOverride ?? `${id}-${version}.${format}`;
  const relArtifact = `${dirName}/artifacts/${fileName}`;
  await writeFile(path.join(root, relArtifact), pkg);

  const manifest = {
    kind: 'tool',
    formatVersion: '1',
    id,
    displayName: options.displayName ?? 'Demo Tool',
    type: 'editor-tool',
    description: 'A tool used to exercise the registry validator.',
    version,
    minUnityVersion: options.minUnityVersion ?? '2020.3',
    minDotNetVersion: options.minDotNetVersion ?? '4.6',
    dependencies: options.dependencies ?? [],
    source: {
      kind: 'bundled',
      type: 'archive',
      artifactFormat: format,
      artifactPath: relArtifact,
    },
    artifacts: [
      { path: relArtifact, format, size: pkg.length, sha256: sha256(pkg) },
    ],
    files: [`Assets/${id}/Demo.cs`],
    install: { contentRoot: 'Assets', editorOnly: true },
  };

  await writeFile(
    path.join(root, dirName, 'tool.utool'),
    serialize(manifest),
    'utf8',
  );

  // Rebuild the index from EVERY payload in the registry, not just this one:
  // tests that call makeRegistry several times must end up with a complete index.
  await refreshIndex(root);

  return { id, version, manifest, artifact: pkg, relArtifact };
}

/** Regenerate index.utool from every payload currently on disk. */
async function refreshIndex(root) {
  const payloadsRoot = path.join(root, 'payloads');
  const ids = (await readdir(payloadsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const manifests = [];
  for (const id of ids) {
    const doc = await readFile(path.join(payloadsRoot, id, 'tool.utool'), 'utf8');
    manifests.push(toManifest(parseUtool(doc, `${id}/tool.utool`)));
  }

  await writeFile(path.join(root, 'index.utool'), serialize(buildIndex(manifests, null)), 'utf8');
}

/**
 * Serialise a document as .utool YAML.
 *
 * Uses the same `yaml` package the production loader reads with, so a test
 * fixture cannot pass because the fixture writer and the reader share a bug.
 * `lineWidth: 0` keeps paths on one line, matching the committed files.
 */
function serialize(value) {
  return stringifyYaml(value, { lineWidth: 0, indent: 2 });
}

/** Build a fetchManifest bound to a registry, always reading the current index. */
async function manifestFetcher(source) {
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  return async (id) => {
    const summary = byId.get(id);
    if (!summary) throw new Error(`unknown tool '${id}' in the index`);
    return toManifest(await source.fetchManifest(summary.manifestPath));
  };
}

/** @returns {Promise<string>} a fresh temp directory */
async function tempDir(prefix = 'utool-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// artifact name conformance (the regression this suite exists for)
// ---------------------------------------------------------------------------

test('conforming artifact names are accepted', () => {
  assert.ok(isConformingArtifactName('core-editor-utils-1.1.0.unitypackage'));
  assert.ok(isConformingArtifactName('my-tool-2.3.1.zip'));
  assert.ok(isConformingArtifactName('tool-1.0.0-rc.1.unitypackage'));
});

test('non-conforming artifact names are rejected', () => {
  // No extension at all.
  assert.ok(!isConformingArtifactName('core-editor-utils-1.1.0'));
  // Extension is not the final component.
  assert.ok(!isConformingArtifactName('core-editor-utils-1.1.0.evil.zip'));
  // Missing version.
  assert.ok(!isConformingArtifactName('core-editor-utils.unitypackage'));
  // Not an allowed container.
  assert.ok(!isConformingArtifactName('core-editor-utils-1.1.0.tar.gz'));
});

test('validator rejects an artifact whose name has a trailing segment', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));

  await makeRegistry(root, { nameOverride: 'demo-tool-1.0.0.evil.unitypackage' });

  const result = await validateRegistry(root);
  assert.equal(result.ok, false, 'a name like <id>-1.0.0.evil.zip must fail validation');
  const codes = result.errors.map((error) => error.code);
  assert.ok(
    codes.includes('E-ARTIFACT-PATH') || codes.includes('E-ARTIFACT-NAME'),
    `expected a path/name error, got: ${JSON.stringify(result.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// validation of a good registry
// ---------------------------------------------------------------------------

test('a well-formed synthetic registry validates', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRegistry(root);

  const result = await validateRegistry(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a tampered artifact is rejected by digest', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { relArtifact } = await makeRegistry(root);

  // Flip the bytes without touching the manifest.
  const file = path.join(root, relArtifact);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(file, bytes);

  const result = await validateRegistry(root);
  assert.equal(result.ok, false);
  const codes = result.errors.map((error) => error.code);
  assert.ok(
    codes.includes('E-ARTIFACT-HASH') || codes.includes('E-ARTIFACT-SIZE'),
    `expected a digest/size error, got ${JSON.stringify(result.errors)}`,
  );
});

test('a loose file in a payload is rejected', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { id } = await makeRegistry(root);

  await writeFile(path.join(root, 'payloads', id, 'Loose.cs'), 'public class Loose {}');

  const result = await validateRegistry(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'E-PAYLOAD-EXTRA'));
});

// ---------------------------------------------------------------------------
// artifact verification
// ---------------------------------------------------------------------------

test('verification catches size, digest, format and unsafe entries', () => {
  const pkg = makeUnitypackage([
    { name: 'aaa/pathname', data: 'Assets/Thing/File.cs' },
    { name: 'aaa/asset', data: 'content' },
  ]);
  const declared = {
    path: 'payloads/thing/artifacts/thing-1.0.0.unitypackage',
    format: ARTIFACT_FORMAT.UNITYPACKAGE,
    size: pkg.length,
    sha256: sha256(pkg),
  };

  const report = verifyArtifactBytes(pkg, declared);
  assert.equal(report.format, ARTIFACT_FORMAT.UNITYPACKAGE);
  assert.deepEqual(report.files, ['Assets/Thing/File.cs']);

  assert.throws(() => verifyArtifactBytes(pkg, { ...declared, size: pkg.length + 1 }), /declared size/);
  assert.throws(() => verifyArtifactBytes(pkg, { ...declared, sha256: 'a'.repeat(64) }), /declared sha256/);
  assert.throws(
    () => verifyArtifactBytes(pkg, { ...declared, format: ARTIFACT_FORMAT.ZIP }),
    /container is/,
  );
});

test('a unitypackage with no pathname entries is rejected', () => {
  const pkg = makeUnitypackage([{ name: 'aaa/asset', data: 'content' }]);
  const declared = {
    path: 'payloads/thing/artifacts/thing-1.0.0.unitypackage',
    format: ARTIFACT_FORMAT.UNITYPACKAGE,
    size: pkg.length,
    sha256: sha256(pkg),
  };
  assert.throws(() => verifyArtifactBytes(pkg, declared), /no pathname entries/);
});

test('archive entries that escape the target are rejected', () => {
  const pkg = makeUnitypackage([
    { name: 'aaa/pathname', data: '../../etc/passwd' },
    { name: 'aaa/asset', data: 'evil' },
  ]);
  const declared = {
    path: 'payloads/thing/artifacts/thing-1.0.0.unitypackage',
    format: ARTIFACT_FORMAT.UNITYPACKAGE,
    size: pkg.length,
    sha256: sha256(pkg),
  };
  // Assert on the stable error code rather than the prose of the message.
  assert.throws(
    () => verifyArtifactBytes(pkg, declared),
    (error) => error.code === 'E-ARTIFACT-UNSAFE' || error.code === 'E-ARTIFACT-PATHNAME',
  );
});

test('an empty pathname is rejected rather than written somewhere undefined', () => {
  const pkg = makeUnitypackage([
    { name: 'aaa/pathname', data: '' },
    { name: 'aaa/asset', data: 'content' },
  ]);
  const declared = {
    path: 'payloads/thing/artifacts/thing-1.0.0.unitypackage',
    format: ARTIFACT_FORMAT.UNITYPACKAGE,
    size: pkg.length,
    sha256: sha256(pkg),
  };
  assert.throws(
    () => verifyArtifactBytes(pkg, declared),
    (error) => error.code === 'E-ARTIFACT-PATHNAME',
  );
});

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

test('resolves required dependencies transitively, dependencies first', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));

  // c -> b -> a
  await makeRegistry(root, { id: 'tool-a' });
  await makeRegistry(root, {
    id: 'tool-b',
    dependencies: [{ id: 'tool-a', version: '^1.0.0' }],
  });
  await makeRegistry(root, {
    id: 'tool-c',
    dependencies: [{ id: 'tool-b', version: '^1.0.0' }],
  });

  const source = new LocalRegistrySource(root);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['tool-c'], fetchManifest);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.steps.map((step) => step.manifest.id),
    ['tool-a', 'tool-b', 'tool-c'],
  );
  // The reason a tool is in the plan is recorded for the UI.
  const stepA = plan.steps.find((step) => step.manifest.id === 'tool-a');
  assert.deepEqual(stepA.installedBecause, ['tool-b']);
});

test('a dependency cycle is a hard error, not auto-broken', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));

  await makeRegistry(root, { id: 'cyc-a', dependencies: [{ id: 'cyc-b' }] });
  await makeRegistry(root, { id: 'cyc-b', dependencies: [{ id: 'cyc-a' }] });

  const source = new LocalRegistrySource(root);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['cyc-a'], fetchManifest);
  assert.ok(plan.problems.some((problem) => problem.code === 'E-DEP-CYCLE'));
  assert.equal(plan.exitCode, EXIT.RESOLUTION);
});

test('an unsatisfiable constraint is reported, not ignored', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));

  await makeRegistry(root, { id: 'dep-lib', version: '1.0.0' });
  await makeRegistry(root, { id: 'needs-two', dependencies: [{ id: 'dep-lib', version: '^2.0.0' }] });

  const source = new LocalRegistrySource(root);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['needs-two'], fetchManifest);
  assert.ok(plan.problems.some((problem) => problem.code === 'E-DEP-VERSION'));
});

test('platform floors block the install and name the tool', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRegistry(root, { id: 'modern-tool', minUnityVersion: '2022.3' });

  const source = new LocalRegistrySource(root);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['modern-tool'], fetchManifest, {
    host: { unityVersion: '2020.3.5f1', dotNetVersion: '4.6' },
  });
  assert.ok(plan.problems.some((problem) => problem.code === 'E-PLATFORM-UNITY'));
  assert.equal(plan.exitCode, EXIT.PLATFORM);
});

test('an optional dependency is used only when already selected', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));

  await makeRegistry(root, { id: 'opt-lib' });
  await makeRegistry(root, {
    id: 'uses-opt',
    dependencies: [{ id: 'opt-lib', version: '^1.0.0', optional: true }],
  });

  const source = new LocalRegistrySource(root);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));

  const resolve = async (requested, alreadySelected) => {
    const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));
    const plan = await resolveSelection(requested, fetchManifest, { alreadySelected });
    return plan.steps.map((step) => step.manifest.id);
  };

  // Not selected: never pulled in on its own.
  assert.deepEqual(await resolve(['uses-opt'], ['uses-opt']), ['uses-opt']);
  // Already selected: the edge is honoured.
  assert.deepEqual(await resolve(['uses-opt', 'opt-lib'], ['uses-opt', 'opt-lib']).then((ids) => ids.sort()), [
    'opt-lib',
    'uses-opt',
  ]);
});

// ---------------------------------------------------------------------------
// install + receipts
// ---------------------------------------------------------------------------

test('plan then install writes the payload and records a receipt', async (t) => {
  const registry = await tempDir('utool-registry-');
  const project = await tempDir('utool-project-');
  t.after(() => rm(registry, { recursive: true, force: true }));
  t.after(() => rm(project, { recursive: true, force: true }));

  const { id } = await makeRegistry(registry, { id: 'install-demo' });

  const source = new LocalRegistrySource(registry);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (toolId) =>
    toManifest(await source.fetchManifest(byId.get(toolId).manifestPath));

  const plan = await resolveSelection([id], fetchManifest);
  const report = await planInstallation(plan, source);
  assert.equal(report.ok, true);

  // The plan reports destinations before anything is written.
  assert.deepEqual(report.tools[0].files.map((file) => file.path), ['Assets/install-demo/Demo.cs']);
  assert.equal(
    existsSync(path.join(project, 'Assets/install-demo/Demo.cs')),
    false,
    'planning must not write anything',
  );

  const store = new ReceiptStore(project);
  const outcome = await executeInstall(report, { projectRoot: project, source, receiptStore: store });

  assert.equal(outcome.installed.length, 1);
  assert.ok(existsSync(path.join(project, 'Assets/install-demo/Demo.cs')));
  assert.equal(
    await readFile(path.join(project, 'Assets/install-demo/Demo.cs'), 'utf8'),
    'public class Demo {}',
  );

  // A receipt exists, is a valid .utool document, and drives uninstall.
  const receipt = await store.read(id);
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.toolId, id);
  assert.deepEqual(receipt.installedFiles, ['Assets/install-demo/Demo.cs']);

  const uninstall = await store.planUninstall([id]);
  assert.deepEqual(uninstall.delete, ['Assets/install-demo/Demo.cs']);
  assert.equal(uninstall.missingReceipts.length, 0);
});

test('a failed artifact verification aborts the whole plan before any write', async (t) => {
  const registry = await tempDir('utool-registry-');
  const project = await tempDir('utool-project-');
  t.after(() => rm(registry, { recursive: true, force: true }));
  t.after(() => rm(project, { recursive: true, force: true }));

  const { relArtifact } = await makeRegistry(registry, { id: 'broken-demo' });
  const bytes = await readFile(path.join(registry, relArtifact));
  bytes[0] ^= 0xff;
  await writeFile(path.join(registry, relArtifact), bytes);

  const source = new LocalRegistrySource(registry);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['broken-demo'], fetchManifest);
  await assert.rejects(() => planInstallation(plan, source));
  // Nothing reached the project.
  assert.equal(existsSync(path.join(project, 'Assets')), false);
});

test('shared files are not deleted while another receipt claims them', async (t) => {
  const project = await tempDir('utool-project-');
  t.after(() => rm(project, { recursive: true, force: true }));

  const store = new ReceiptStore(project);
  const common = {
    artifactSha256: 'a'.repeat(64),
    artifactFormat: 'unitypackage',
    installedAtUtc: '2026-01-01T00:00:00Z',
    registryRef: null,
    registryCommit: null,
    installedByTools: ['user'],
  };

  await store.write({
    ...common,
    toolId: 'lib-a',
    version: '1.0.0',
    installedFiles: ['Assets/Shared/Common.cs', 'Assets/LibA/Only.cs'],
  });
  await store.write({
    ...common,
    toolId: 'lib-b',
    version: '1.0.0',
    installedFiles: ['Assets/Shared/Common.cs', 'Assets/LibB/Only.cs'],
  });

  const plan = await store.planUninstall(['lib-a']);
  // Only lib-a's exclusive file may go; the shared one stays with lib-b.
  assert.deepEqual(plan.delete, ['Assets/LibA/Only.cs']);
  assert.deepEqual(plan.keep, [{ file: 'Assets/Shared/Common.cs', claimedBy: ['lib-b'] }]);

  // Removing both releases the shared file.
  const both = await store.planUninstall(['lib-a', 'lib-b']);
  assert.deepEqual(both.delete, ['Assets/LibA/Only.cs', 'Assets/LibB/Only.cs', 'Assets/Shared/Common.cs']);
  assert.deepEqual(both.keep, []);
});

// ---------------------------------------------------------------------------
// the real registry
// ---------------------------------------------------------------------------

test('the shipped registry validates through the Node backend', async () => {
  const result = await validateRegistry(REGISTRY);
  assert.deepEqual(
    result.errors,
    [],
    `the shipped registry must validate; errors: ${JSON.stringify(result.errors, null, 2)}`,
  );
  assert.ok(result.manifests.length >= 3);
});

test('the shipped registry resolves its example dependency chain', async () => {
  const source = new LocalRegistrySource(REGISTRY);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['editor-tool-selection-history'], fetchManifest);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.steps.map((step) => step.manifest.id),
    ['core-editor-utils', 'editor-tool-selection-history'],
        'the dependency must be ordered before the tool that needs it',
  );
});

test('external tools are reported as caller-resolved, never silently installed', async () => {
  const source = new LocalRegistrySource(REGISTRY);
  const index = await source.fetchIndex();
  const byId = new Map(index.tools.map((tool) => [tool.id, tool]));
  const fetchManifest = async (id) => toManifest(await source.fetchManifest(byId.get(id).manifestPath));

  const plan = await resolveSelection(['libs-gltf-importer'], fetchManifest);
  const report = await planInstallation(plan, source);
  assert.equal(report.tools.length, 1);
  assert.ok(report.tools[0].skipped, 'an external git source must be marked as skipped');
  assert.match(report.tools[0].skipped, /resolved by the caller/);
});

test('extractUnitypackage writes assets to their pathname destinations', async (t) => {
  const project = await tempDir('utool-extract-');
  t.after(() => rm(project, { recursive: true, force: true }));

  const pkg = makeUnitypackage([
    { name: 'a1/pathname', data: 'Assets/One/File.cs' },
    { name: 'a1/asset', data: 'one' },
    { name: 'b2/pathname', data: 'Packages/com.x.tool/Two.cs' },
    { name: 'b2/asset', data: 'two' },
  ]);

  const written = await extractUnitypackage(pkg, project);
  assert.deepEqual(written, ['Assets/One/File.cs', 'Packages/com.x.tool/Two.cs']);
  assert.equal(await readFile(path.join(project, 'Assets/One/File.cs'), 'utf8'), 'one');
  assert.equal(await readFile(path.join(project, 'Packages/com.x.tool/Two.cs'), 'utf8'), 'two');
});
