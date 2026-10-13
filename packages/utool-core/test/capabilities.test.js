/**
 * Capability provider selection tests.
 *
 * `injects` is worthless if nothing acts on it. These prove the two halves of the
 * promise: off by default (no silent additions), on request it chooses a provider
 * deterministically and records why, and the alternatives are reported so a user can
 * see what could have been swapped in.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSelection, toManifest } from '../src/index.js';

function tool(id, overrides = {}) {
  return toManifest({
    kind: 'tool',
    formatVersion: '2',
    id,
    displayName: id,
    type: 'tool-library',
    description: `synthetic tool ${id} for capability resolution tests`,
    version: '1.0.0',
    provides: [],
    injects: [],
    dependencies: [],
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
    ...overrides,
  });
}

/** A tiny registry: manifests by id, plus a capability index. */
function registry(tools) {
  const byId = new Map(tools.map((entry) => [entry.id, entry]));
  const byCapability = new Map();
  for (const entry of tools) {
    for (const capability of entry.provides) {
      if (!byCapability.has(capability)) byCapability.set(capability, []);
      byCapability.get(capability).push(entry.id);
    }
  }
  return {
    fetchManifest: async (id) => {
      const found = byId.get(id);
      if (!found) throw new Error(`no tool '${id}'`);
      return found;
    },
    listProviders: async (capability) => byCapability.get(capability) ?? [],
  };
}

test('by default an unsatisfied inject is reported and nothing extra is added', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const provider = tool('json-lib', { provides: ['data.json.serialization'] });
  const { fetchManifest, listProviders } = registry([consumer, provider]);

  const plan = await resolveSelection(['consumer'], fetchManifest, { engine: 'unity' });

  assert.ok(plan.problems.some((problem) => problem.code === 'E-CAP-UNSATISFIED'));
  assert.deepEqual(
    plan.steps.map((step) => step.manifest.id),
    ['consumer'],
    'a provider must not be pulled in silently',
  );
  assert.deepEqual(plan.providerChoices, []);
  void listProviders;
});

test('on request a provider is selected, and the choice is recorded', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const provider = tool('json-lib', { provides: ['data.json.serialization'] });
  const { fetchManifest, listProviders } = registry([consumer, provider]);

  const plan = await resolveSelection(['consumer'], fetchManifest, {
    engine: 'unity',
    autoResolveInjects: true,
    listProviders,
  });

  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.steps.map((step) => step.manifest.id).sort(),
    ['consumer', 'json-lib'],
  );

  assert.equal(plan.providerChoices.length, 1);
  assert.deepEqual(plan.providerChoices[0], {
    capability: 'data.json.serialization',
    provider: 'json-lib',
    neededBy: 'consumer',
    alternatives: [],
  });

  // The reason is attributed, so a UI can say why the extra tool appeared.
  const chosen = plan.steps.find((step) => step.manifest.id === 'json-lib');
  assert.deepEqual(chosen.installedBecause, ['consumer']);
});

test('with several providers the choice is deterministic and alternatives are listed', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const alpha = tool('alpha-json', { provides: ['data.json.serialization'] });
  const beta = tool('beta-json', { provides: ['data.json.serialization'] });
  const { fetchManifest, listProviders } = registry([consumer, beta, alpha]);

  // Run twice with the providers supplied in different orders: the plan must be the
  // same both times, or two installs of the same selection would write different
  // receipts.
  for (const order of [[alpha, beta], [beta, alpha]]) {
    const { fetchManifest: fetch2, listProviders: list2 } = registry([consumer, ...order]);
    const plan = await resolveSelection(['consumer'], fetch2, {
      engine: 'unity',
      autoResolveInjects: true,
      listProviders: list2,
    });
    assert.equal(plan.providerChoices[0].provider, 'alpha-json', 'lowest id wins, always');
    assert.deepEqual(plan.providerChoices[0].alternatives, ['beta-json']);
  }
  void fetchManifest;
  void listProviders;
});

test('an inject already satisfied by the selection adds nothing', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const provider = tool('json-lib', { provides: ['data.json.serialization'] });
  const { fetchManifest, listProviders } = registry([consumer, provider]);

  const plan = await resolveSelection(['consumer', 'json-lib'], fetchManifest, {
    engine: 'unity',
    autoResolveInjects: true,
    listProviders,
  });

  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.providerChoices, [], 'nothing was chosen, because the user already did');
  assert.equal(plan.steps.length, 2);
});

test('a provider that does not support the engine is refused, with a reason', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const godotOnly = toManifest({
    kind: 'tool',
    formatVersion: '2',
    id: 'godot-json',
    displayName: 'Godot JSON',
    type: 'tool-library',
    description: 'a provider that exists only for another engine',
    version: '1.0.0',
    provides: ['data.json.serialization'],
    targets: {
      godot: {
        requirements: { minEngineVersion: '4.2' },
        artifact: { type: 'external', source: 'git', url: 'https://example.com/g.git', ref: 'v1' },
      },
    },
  });
  const { fetchManifest, listProviders } = registry([consumer, godotOnly]);

  const plan = await resolveSelection(['consumer'], fetchManifest, {
    engine: 'unity',
    autoResolveInjects: true,
    listProviders,
  });

  const problem = plan.problems.find((entry) => entry.code === 'E-CAP-PROVIDER-ENGINE');
  assert.ok(problem, `expected an engine mismatch, got ${JSON.stringify(plan.problems)}`);
  assert.equal(problem.provider, 'godot-json');
});

test('a provider with an unmet own dependency is refused rather than half-added', async () => {
  const consumer = tool('consumer', { injects: ['data.json.serialization'] });
  const provider = tool('json-lib', {
    provides: ['data.json.serialization'],
    dependencies: [{ id: 'missing-helper', version: '^1.0.0' }],
  });
  const { fetchManifest, listProviders } = registry([consumer, provider]);

  const plan = await resolveSelection(['consumer'], fetchManifest, {
    engine: 'unity',
    autoResolveInjects: true,
    listProviders,
  });

  const problem = plan.problems.find((entry) => entry.code === 'E-CAP-PROVIDER-DEP');
  assert.ok(problem, `expected a provider dependency problem, got ${JSON.stringify(plan.problems)}`);
  assert.equal(problem.toolId, 'json-lib');
});
