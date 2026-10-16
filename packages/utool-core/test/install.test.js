/**
 * Install tests against the REAL registry artifacts.
 *
 * These exist for a bug that only an end-to-end install could reveal: the archive
 * handler reported the paths as they appear INSIDE the archive, not as they land in
 * the project. With a `contentRoot` the two differ, so the receipt named
 * `plugin.cfg` while the file was at `addons/core_utils/plugin.cfg`. Uninstall would
 * then have looked in the wrong place - and every unit test passed, because the unit
 * tests checked the archive reader rather than the receipt.
 *
 * The rule these lock in: a receipt must name where a file IS.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LocalRegistrySource,
  ReceiptStore,
  executeInstall,
  planInstallation,
  resolveSelection,
  toManifest,
} from '../src/index.js';
import { REGISTRY, registryTest, makeContainers } from './helpers.js';

/** A source that reads artifacts from disk, like LocalRegistrySource does. */
function localSource(root) {
  return new LocalRegistrySource(root);
}

async function buildPlan(registryRoot, ids, options = {}) {
  const source = localSource(registryRoot);
  const index = await source.fetchIndex();
  const byId = new Map((index.tools ?? []).map((tool) => [tool.id, tool]));

  const plan = await resolveSelection(
    ids,
    async (id) => {
      const summary = byId.get(id);
      if (!summary) throw new Error(`no tool '${id}' in the index`);
      return toManifest(await source.fetchManifest(summary.manifestPath));
    },
    options,
  );
  return { source, plan };
}

test('installing a cross-engine tool writes each engine to its own location', registryTest(), async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'utool-install-'));
  t.after(() => rm(project, { recursive: true, force: true }));

  const containers = makeContainers();
  const { source, plan } = await buildPlan(REGISTRY, ['core-editor-utils'], {
    engine: 'unity',
    alsoEngines: ['godot'],
  });
  assert.deepEqual(plan.problems, []);

  const report = await planInstallation(plan, source, containers);
  assert.equal(report.ok, true);

  const store = new ReceiptStore(project);
  const outcome = await executeInstall(report, {
    projectRoot: project,
    source,
    containers,
    receiptStore: store,
  });

  // One receipt for the tool, covering both engines.
  const receipts = await store.list();
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].installedEngines, ['godot', 'unity']);

  // The critical assertion: every recorded path exists on disk. This is what the
  // archive-handler bug violated, for the godot files specifically.
  for (const file of receipts[0].installedFiles) {
    assert.ok(
      existsSync(path.join(project, file)),
      `receipt names '${file}' but nothing is there - contentRoot was not applied`,
    );
  }

  // And spot-check the two locations the manifest actually declares. Each engine
  // installs into its OWN tool-named directory: a payload that scattered into
  // shared folders such as Assets/Runtime and Assets/Editor would spread one tool
  // across the project, so "the files this tool owns" would stop being definable.
  assert.ok(existsSync(path.join(project, 'Assets/CoreEditorUtils/Runtime/Core/Guard.cs')), 'unity target');
  assert.ok(
    existsSync(path.join(project, 'addons/core_utils/plugin.cfg')),
    'godot target must land under its contentRoot',
  );
  assert.equal(outcome.installed.length, 2, 'one install per engine');

  // Self-containment, stated as the property rather than as one literal path: every
  // installed file sits under a single directory named for the tool.
  const roots = new Set(
    receipts[0].installedFiles.map((file) => file.split('/').slice(0, 2).join('/')),
  );
  assert.equal(roots.size, 2, `one root per engine, got: ${[...roots].join(', ')}`);
  assert.ok([...roots].includes('Assets/CoreEditorUtils'), 'the unity root is tool-named');
  assert.ok([...roots].includes('addons/core_utils'), 'the godot root is tool-named');
});

test('a receipt lets the payload be removed with no residue', registryTest(), async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'utool-uninstall-'));
  t.after(() => rm(project, { recursive: true, force: true }));

  const containers = makeContainers();
  const { source, plan } = await buildPlan(REGISTRY, ['libs-sharp-json'], { engine: 'unity' });
  const report = await planInstallation(plan, source, containers);
  const store = new ReceiptStore(project);
  await executeInstall(report, { projectRoot: project, source, containers, receiptStore: store });

  const receipt = await store.read('libs-sharp-json');
  assert.deepEqual(receipt.installedFiles, ['Assets/SharpJson/SharpJson.dll']);
  assert.ok(existsSync(path.join(project, 'Assets/SharpJson/SharpJson.dll')));

  // A bare dll must land in a TOOL-OWNED directory, not a shared engine one.
  // Assets/Plugins is where developers put their own native and managed plugins, so
  // a tool installing there cannot be uninstalled without risking their work.
  const sharedEngineDirs = ['Assets/Plugins', 'Assets/Editor', 'Assets/Resources'];
  for (const file of receipt.installedFiles) {
    for (const shared of sharedEngineDirs) {
      assert.ok(
        !file.startsWith(`${shared}/`),
        `'${file}' installs into ${shared}, a shared engine directory`,
      );
    }
  }

  const plan2 = await store.planUninstall(['libs-sharp-json']);
  assert.deepEqual(plan2.delete, ['Assets/SharpJson/SharpJson.dll']);
  assert.deepEqual(plan2.keep, []);
});

test('a tampered artifact aborts the plan before anything is written', registryTest(), async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'utool-tamper-'));
  t.after(() => rm(project, { recursive: true, force: true }));

  // A source that returns the wrong bytes for the artifact.
  const containers = makeContainers();
  const { source, plan } = await buildPlan(REGISTRY, ['libs-sharp-json'], { engine: 'unity' });

  const lyingSource = {
    ...source,
    fetchArtifact: async () => Buffer.from('not the dll that was declared'),
    fetchManifest: source.fetchManifest.bind(source),
    fetchIndex: source.fetchIndex.bind(source),
  };

  await assert.rejects(
    () => planInstallation(plan, lyingSource, containers),
    (error) => error.code === 'E-ARTIFACT-SIZE' || error.code === 'E-ARTIFACT-HASH',
  );

  // Nothing reached the project: the plan phase failed before the write phase.
  assert.equal(existsSync(path.join(project, 'Assets')), false);
});

test('an external target is reported, never silently installed', registryTest(), async (t) => {
  const containers = makeContainers();
  const { source, plan } = await buildPlan(REGISTRY, ['libs-gltf-importer'], { engine: 'unity' });
  const report = await planInstallation(plan, source, containers);

  assert.equal(report.tools.length, 1);
  assert.ok(report.tools[0].skipped, 'an external source must be marked');
  assert.match(report.tools[0].skipped, /resolved by the caller/);
});

test('the engine floor blocks the install and names the requirement', registryTest(), async (t) => {
  const containers = makeContainers();
  const { plan } = await buildPlan(REGISTRY, ['editor-tool-selection-history'], {
    engine: 'unity',
    meetsRequirement: (engine, key, value) => {
      if (engine === 'unity' && key === 'minEngineVersion') return false;
      return undefined;
    },
  });

  assert.ok(plan.problems.some((problem) => problem.code === 'E-PLATFORM'));
  const problem = plan.problems.find((entry) => entry.code === 'E-PLATFORM');
  assert.equal(problem.requirement, 'minEngineVersion');
  assert.ok(problem.required, 'the floor itself must be reported, not just that one exists');
});

/**
 * A minimal v3 tool whose only target is an external git source.
 *
 * Short enough to inline repeatedly, and it keeps the version-scoped fields inside
 * `versions[]` where v3 puts them, so a fixture cannot quietly use the old flat shape.
 */
function syntheticTool(id, extras = {}) {
  return toManifest({
    kind: 'tool',
    formatVersion: '3',
    id,
    displayName: id,
    type: 'tool-library',
    description: `${id} is a synthetic tool used by the install tests`,
    latest: '1.0.0',
    versions: [
      {
        version: '1.0.0',
        targets: {
          unity: {
            requirements: { minEngineVersion: '2019.4' },
            artifact: {
              type: 'external',
              source: 'git',
              url: `https://example.com/${id}.git`,
              ref: 'v1',
            },
          },
        },
      },
    ],
    ...extras,
  });
}

test('a capability conflict is reported', registryTest(), async (t) => {
  // The shipped registry has no conflict, so it is exercised through the resolver
  // directly with a synthetic pair of manifests.
  const conflict = [
    syntheticTool('one', { provides: ['shared.capability'] }),
    syntheticTool('two', { provides: ['shared.capability'] }),
  ];
  const byId = new Map(conflict.map((manifest) => [manifest.id, manifest]));

  const plan = await resolveSelection(['one', 'two'], async (id) => byId.get(id), { engine: 'unity' });
  const problem = plan.problems.find((entry) => entry.code === 'E-CAP-CONFLICT');
  assert.ok(problem, `expected a conflict, got ${JSON.stringify(plan.problems)}`);
  assert.deepEqual(problem.providers, ['one', 'two']);
});

test('an unsatisfiable inject is reported', registryTest(), async (t) => {
  const lonely = syntheticTool('needs-help', { injects: ['nobody.provides.this'] });

  const plan = await resolveSelection(['needs-help'], async () => lonely, { engine: 'unity' });
  const problem = plan.problems.find((entry) => entry.code === 'E-CAP-UNSATISFIED');
  assert.ok(problem, `expected an unsatisfied inject, got ${JSON.stringify(plan.problems)}`);
  assert.equal(problem.capability, 'nobody.provides.this');
});

/**
 * A tool publishing several versions, one of them withdrawn.
 *
 * Version pinning is the reason `versions[]` exists at all, so the fixtures for it need
 * more than one release and a yanked one to tell "explicitly requested" apart from
 * "chosen automatically".
 */
function multiVersionTool(id, { yanked = [], latest = '1.0.0' } = {}) {
  const entry = (version) => ({
    version,
    yanked: yanked.includes(version),
    releasedAt: '2026-01-01',
    targets: {
      unity: {
        requirements: { minEngineVersion: '2019.4' },
        artifact: {
          type: 'external',
          source: 'git',
          url: `https://example.com/${id}.git`,
          ref: `v${version}`,
        },
      },
    },
  });

  return toManifest({
    kind: 'tool',
    formatVersion: '3',
    id,
    displayName: id,
    type: 'tool-library',
    description: `${id} publishes several versions`,
    latest,
    versions: [entry('1.0.0'), entry('0.9.0')],
  });
}

test('without a pin the latest release is planned', registryTest(), async () => {
  const tool = multiVersionTool('multi');
  const plan = await resolveSelection(['multi'], async () => tool, { engine: 'unity' });
  assert.equal(plan.steps[0].manifest.version, '1.0.0');
  assert.equal(plan.problems.length, 0, JSON.stringify(plan.problems));
});

test('an explicit pin installs that version, not latest', registryTest(), async () => {
  const tool = multiVersionTool('multi');
  const plan = await resolveSelection(['multi@0.9.0'], async () => tool, { engine: 'unity' });

  // The regression this exists for: the pin used to be silently ignored and latest installed.
  assert.equal(plan.steps[0].manifest.version, '0.9.0');
  assert.equal(plan.steps[0].requestedVersion, '0.9.0');
  assert.equal(plan.problems.length, 0, JSON.stringify(plan.problems));
});

/**
 * The dangerous case: a pin that cannot be honoured must never be quietly swapped.
 *
 * It used to plan and install `latest` and exit 0 with no message, which is the one
 * outcome a version pin exists to prevent - the user asked for 9.9.9 and would have got
 * 1.0.0 while being told everything was fine.
 */
test('a pin naming an unpublished version is reported, not swapped', registryTest(), async () => {
  const tool = multiVersionTool('multi');
  const plan = await resolveSelection(['multi@9.9.9'], async () => tool, { engine: 'unity' });

  const problem = plan.problems.find((entry) => entry.code === 'E-VERSION-NOT-FOUND');
  assert.ok(problem, `expected a version problem, got ${JSON.stringify(plan.problems)}`);
  assert.equal(problem.toolId, 'multi');
  // The message must name what WAS available, or the user cannot correct the pin.
  assert.match(problem.message, /9\.9\.9/);
  assert.match(problem.message, /1\.0\.0/);
});

/**
 * `yanked` means "never chosen automatically". A version named by hand is not automatic,
 * so an explicit pin still reaches it - a receipt may already reference it.
 */
test('an explicit pin reaches a withdrawn release', registryTest(), async () => {
  const tool = multiVersionTool('multi', { yanked: ['0.9.0'] });
  const plan = await resolveSelection(['multi@0.9.0'], async () => tool, { engine: 'unity' });

  assert.equal(plan.steps[0].manifest.version, '0.9.0');
  assert.equal(plan.problems.length, 0, JSON.stringify(plan.problems));
});

test('a withdrawn release is still not chosen on its own', registryTest(), async () => {
  const tool = multiVersionTool('multi', { yanked: ['1.0.0'], latest: '0.9.0' });
  const plan = await resolveSelection(['multi'], async () => tool, { engine: 'unity' });

  assert.equal(plan.steps[0].manifest.version, '0.9.0');
});
