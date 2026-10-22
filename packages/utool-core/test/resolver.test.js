/**
 * Resolver tests for version selection.
 *
 * These exist because version selection had no test and crashed: `resolveDependencyVersion`
 * is a module-level function that read `versionsRequested`, a local of `resolveSelection`.
 * The first dependency constraint on a multi-version dependency therefore threw
 * `versionsRequested is not defined` - in the editor it surfaced as "verify and plan" failing
 * for the one tool in the registry that depends on a multi-version library.
 *
 * The rules these lock in: a constraint picks the release it names, two consumers narrow to
 * their intersection, and an explicit `id@version` beats both.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSelection, toManifest } from '../src/index.js';

/** A minimal but complete formatVersion 3 document. */
function manifestDoc(id, versions, extra = {}) {
  const latest = versions[versions.length - 1];
  return {
    kind: 'tool',
    formatVersion: '3',
    id,
    displayName: id,
    type: 'tool-library',
    description: 'A fixture.',
    license: 'MIT',
    author: 'Someone',
    homepage: 'https://example.invalid',
    tags: [],
    provides: [],
    injects: [],
    latest,
    dependencies: [],
    versions: versions.map((version) => ({
      version,
      targets: {
        unity: {
          requirements: { minEngineVersion: '2020.3' },
          artifact: {
            type: 'file',
            format: 'dll',
            path: `payloads/${id}/artifacts/${id}-${version}.dll`,
            size: 1,
            sha256: '0'.repeat(64),
            unpack: 'none',
            targetPath: `Assets/${id}/${id}.dll`,
            files: [`Assets/${id}/${id}.dll`],
          },
        },
      },
    })),
    ...extra,
  };
}

/** Resolve against a set of in-memory manifests, failing on an id that was not declared. */
async function resolve(ids, docs, options = {}) {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  return resolveSelection(
    ids,
    async (id) => {
      if (!byId.has(id)) throw new Error(`no fixture for '${id}'`);
      return toManifest(byId.get(id));
    },
    { engine: 'unity', ...options },
  );
}

/** The version each step of a plan installs, as { id: version }. */
function versionsOf(plan) {
  const found = {};
  for (const step of plan.steps) found[step.manifest.id] = step.manifest.version;
  return found;
}

test('a constraint installs the release it names, not the dependency\'s latest', async () => {
  const plan = await resolve(
    ['app'],
    [
      manifestDoc('app', ['1.0.0'], {
        dependencies: [{ id: 'lib', version: '^1.0.0' }],
      }),
      manifestDoc('lib', ['1.0.0', '1.4.0', '2.0.0']),
    ],
  );

  assert.deepEqual(plan.problems, []);
  // The regression: this threw `versionsRequested is not defined` before anything was planned.
  assert.deepEqual(versionsOf(plan), { app: '1.0.0', lib: '1.4.0' });
});

test('two consumers narrow the same dependency to their intersection', async () => {
  const plan = await resolve(
    ['app-a', 'app-b'],
    [
      manifestDoc('app-a', ['1.0.0'], { dependencies: [{ id: 'lib', version: '^1.0.0' }] }),
      manifestDoc('app-b', ['1.0.0'], { dependencies: [{ id: 'lib', version: '^1.2.0' }] }),
      manifestDoc('lib', ['1.0.0', '1.2.0', '1.9.0', '2.0.0']),
    ],
  );

  assert.deepEqual(plan.problems, []);
  // ^1.2.0 already excludes 1.0.0; agreeing on one release is what keeps the receipt honest.
  assert.equal(versionsOf(plan).lib, '1.9.0');
});

test('an unsatisfiable constraint is reported rather than silently swapped', async () => {
  const plan = await resolve(
    ['app'],
    [
      manifestDoc('app', ['1.0.0'], { dependencies: [{ id: 'lib', version: '^3.0.0' }] }),
      manifestDoc('lib', ['1.0.0', '2.0.0']),
    ],
  );

  assert.equal(plan.problems.length, 1);
  assert.equal(plan.problems[0].code, 'E-DEP-VERSION');
});

test('an explicit id@version wins over the dependency constraint', async () => {
  const plan = await resolve(
    ['app', 'lib@1.0.0'],
    [
      manifestDoc('app', ['1.0.0'], { dependencies: [{ id: 'lib', version: '^1.0.0' }] }),
      manifestDoc('lib', ['1.0.0', '1.4.0']),
    ],
  );

  assert.deepEqual(plan.problems, []);
  // A hand-typed pin is not a suggestion: narrowing it against a constraint is right,
  // overriding it is not.
  assert.equal(versionsOf(plan).lib, '1.0.0');
});
