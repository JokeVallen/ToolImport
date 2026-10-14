/**
 * Engine-decoupling tests.
 *
 * The property under test is the one that motivated formatVersion 2: the core must
 * work with no engine knowledge at all, and must gain Unity support only when the
 * Unity adapter is registered. If the core ever grows an `if Unity` branch, or if
 * registering the adapter stops being what enables unitypackage handling, these
 * fail.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  ARTIFACT_TYPE,
  CORE_ARCHIVE_FORMATS,
  FORMAT_VERSION,
  createCoreContainerRegistry,
  isCapability,
  expectedArtifactName,
  artifactNameEngine,
  toManifest,
  verifyArtifactBytes,
  parseUnityVersion,
  compareUnityVersions,
} from '../src/index.js';
import { unityAdapter, UNITYPACKAGE_FORMAT } from '../../../providers/engine-unity/src/index.js';
import { REGISTRY, makeContainers, makeCoreOnlyContainers } from './helpers.js';

test('the core declares no engine-specific container format', () => {
  const containers = makeCoreOnlyContainers();
  const formats = containers.formats();

  for (const format of CORE_ARCHIVE_FORMATS) {
    assert.ok(formats.includes(format), `core should handle ${format}`);
  }
  assert.ok(
    !formats.includes(UNITYPACKAGE_FORMAT),
    'unitypackage must not be a core format: it is a Unity concept',
  );
  assert.ok(formats.includes('zip'), 'zip is the universal default and must be core');
});

test('registering the Unity adapter is what adds unitypackage support', () => {
  const before = makeCoreOnlyContainers();
  assert.equal(before.for(UNITYPACKAGE_FORMAT), null);

  const after = makeContainers();
  assert.equal(after.for(UNITYPACKAGE_FORMAT)?.id, 'unity:unitypackage');
});

test('registering two handlers for one format is rejected, not silently won', () => {
  const containers = makeCoreOnlyContainers();
  containers.register(unityAdapter.containerHandlers[0]);
  assert.throws(
    () => containers.register({ id: 'rival:unitypackage', formats: ['unitypackage'], inspect() {}, extract() {} }),
    /already registered/,
  );
});

test('a Unity payload cannot be verified without the Unity adapter', () => {
  const artifactPath = path.join(
    REGISTRY,
    'payloads/editor-tool-selection-history/artifacts/editor-tool-selection-history-1.0.0.unitypackage',
  );
  const bytes = readFileSync(artifactPath);
  const manifestDoc = readFileSync(
    path.join(REGISTRY, 'payloads/editor-tool-selection-history/tool.yaml'),
    'utf8',
  );

  // Rebuild the declared-artifact shape from the real manifest.
  const manifest = toManifest(requireYaml(manifestDoc));
  const declared = manifest.target('unity').declaredArtifact;

  // With no adapter: a specific, actionable refusal.
  assert.throws(
    () => verifyArtifactBytes(bytes, declared, makeCoreOnlyContainers()),
    (error) => error.code === 'E-ARTIFACT-FORMAT-UNSUPPORTED' && /adapter/i.test(error.message),
  );

  // With the adapter: verified, and the destinations come from the pathnames.
  const report = verifyArtifactBytes(bytes, declared, makeContainers());
  assert.equal(report.format, UNITYPACKAGE_FORMAT);
  assert.deepEqual(report.items.map((item) => item.path).sort(), [
    'Assets/SelectionHistory/SelectionHistoryTracker.cs',
    'Assets/SelectionHistory/SelectionHistoryWindow.cs',
  ]);
});

test('the Unity adapter compares only the requirement keys it owns', () => {
  const host = { engineVersion: '2021.3.5f1', runtimeVersion: '4.6' };

  assert.equal(unityAdapter.meetsRequirement('unity', 'minEngineVersion', '2020.3', host), true);
  assert.equal(unityAdapter.meetsRequirement('unity', 'minEngineVersion', '2022.3', host), false);
  assert.equal(unityAdapter.meetsRequirement('unity', 'minRuntimeVersion', '4.6', host), true);
  assert.equal(unityAdapter.meetsRequirement('unity', 'minRuntimeVersion', '6.0', host), false);

  // An unknown key is "cannot judge", NOT false. Returning false here would block
  // installs the moment someone adds a requirement key this adapter has not
  // learned yet, which is exactly the coupling the adapter split exists to avoid.
  assert.equal(unityAdapter.meetsRequirement('unity', 'minApiVersion', '4.2', host), undefined);
  assert.equal(unityAdapter.meetsRequirement('godot', 'minEngineVersion', '4.2', host), undefined);
  // With no host facts, the floor is reported rather than enforced.
  assert.equal(unityAdapter.meetsRequirement('unity', 'minEngineVersion', '2020.3', {}), undefined);
});

test('a host with no declared runtime version leaves that floor unjudged', () => {
  const host = unityAdapter.hostFacts({ unityVersion: '2021.3.5f1' });
  assert.equal(host.engineVersion, '2021.3.5f1');
  assert.equal(host.runtimeVersion, null);
  assert.equal(unityAdapter.meetsRequirement('unity', 'minRuntimeVersion', '4.6', host), undefined);
});

test('capability names must be namespaced', () => {
  assert.ok(isCapability('unity.window.selection-history'));
  assert.ok(isCapability('script.api.argument-guards'));
  assert.ok(!isCapability('selection-history'), 'a bare word states no namespace');
  assert.ok(!isCapability('Unity.Window'), 'capabilities are lowercase');
  assert.ok(!isCapability('unity..window'), 'empty segment');
});

test('artifact names carry the engine segment only when a manifest is multi-engine', () => {
  assert.equal(
    expectedArtifactName('core-editor-utils', '1.1.0', 'unity', true, 'unitypackage'),
    'core-editor-utils-1.1.0-unity.unitypackage',
  );
  assert.equal(
    expectedArtifactName('libs-sharp-json', '3.0.0', 'unity', false, 'dll'),
    'libs-sharp-json-3.0.0.dll',
  );
  // tar.gz and tgz are the same container and must map to one extension.
  assert.equal(
    expectedArtifactName('tool', '1.0.0', 'godot', true, 'tar.gz'),
    'tool-1.0.0-godot.tgz',
  );
  assert.equal(artifactNameEngine('core-editor-utils-1.1.0-unity.unitypackage'), 'unity');
  assert.equal(artifactNameEngine('libs-sharp-json-3.0.0.dll'), null);
});

test('formatVersion is 3 and the loader rejects 2', () => {
  assert.equal(FORMAT_VERSION, '3');
});

test('a single-file payload still verifies size and digest', () => {
  const bytes = Buffer.from('dll bytes');
  const declared = {
    type: ARTIFACT_TYPE.FILE,
    format: 'dll',
    path: 'payloads/x/artifacts/x-1.0.0.dll',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    targetPath: 'Assets/Plugins/X.dll',
  };

  const report = verifyArtifactBytes(bytes, declared, makeCoreOnlyContainers());
  assert.deepEqual(report.items, [{ path: 'Assets/Plugins/X.dll', size: bytes.length }]);

  assert.throws(
    () => verifyArtifactBytes(bytes, { ...declared, sha256: 'a'.repeat(64) }, makeCoreOnlyContainers()),
    (error) => error.code === 'E-ARTIFACT-HASH',
  );
  // A destination that escapes the project is refused even for a single file.
  assert.throws(
    () =>
      verifyArtifactBytes(
        bytes,
        { ...declared, targetPath: '../../etc/passwd' },
        makeCoreOnlyContainers(),
      ),
    (error) => error.code === 'E-ARTIFACT-UNSAFE',
  );
  // type file requires targetPath, or the destination is undefined.
  assert.throws(
    () => verifyArtifactBytes(bytes, { ...declared, targetPath: undefined }, makeCoreOnlyContainers()),
    (error) => error.code === 'E-ARTIFACT-TARGETPATH',
  );
});

// Small local helper so the YAML step reads clearly at the call site.
function requireYaml(text) {
  return parseYaml(text);
}

test('Unity distribution builds with a cN revision parse and order correctly', () => {
  // Regression: Application.unityVersion reports strings like "2021.3.45f1c2"
  // on distribution builds. The original pattern accepted a single stage letter
  // only, so every such host failed the floor check with E-PLATFORM-PARSE and
  // the plan could not be produced at all -- on a perfectly valid editor.
  const host = unityAdapter.hostFacts({ unityVersion: '2021.3.45f1c2' });
  assert.equal(host.engineVersion, '2021.3.45f1c2');
  assert.equal(unityAdapter.meetsRequirement('unity', 'minEngineVersion', '2019.4', host), true);
  assert.equal(unityAdapter.meetsRequirement('unity', 'minEngineVersion', '2022.1', host), false);

  // The revision is a real ordering dimension, not noise to discard.
  assert.ok(compareUnityVersions('2021.3.45f1c2', '2021.3.45f1') > 0);
  assert.ok(compareUnityVersions('2022.3.57f1c1', '2022.3.57f1c2') < 0);
  // A trailing internal hash carries no ordering.
  assert.equal(compareUnityVersions('2023.2.10f1 (316c1fd686f6)', '2023.2.10f1'), 0);
  // Streams still order a < b < f.
  assert.ok(compareUnityVersions('2023.3.0a17', '2023.3.0b4') < 0);
  assert.throws(() => parseUnityVersion('not-a-version'), (error) => error instanceof TypeError);
});
