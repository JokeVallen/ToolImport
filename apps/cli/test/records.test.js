/**
 * Tests for the `--records` output contract.
 *
 * This contract is the seam the Unity front end parses, and it had no test. A field that
 * stops being emitted does not throw anywhere: the C# reader keys on the record name and
 * silently yields an empty string, so the editor shows a blank where a value should be.
 * That is exactly what `DETAIL version` did - it read the raw document, which in
 * formatVersion 3 has `latest` and a `versions` list but no top-level `version` at all,
 * so every tool reported an empty version and nothing failed.
 *
 * So these tests assert the VALUES, not merely that a record type appears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolDetail, toolTargets, toolSummaries, meta, receipts, installPlan, uninstallPlan, RECORDS_VERSION } from '../lib/records.js';

/** Capture what the record writers put on stdout, as parsed records. */
function capture(write) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    write();
  } finally {
    process.stdout.write = original;
  }

  return chunks.join('').split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { type: parts[0], fields: parts.slice(1) };
  });
}

/** All values of one DETAIL key, in order. */
function details(records, key) {
  return records
    .filter((r) => r.type === 'DETAIL' && r.fields[0] === key)
    .map((r) => r.fields[1]);
}

function find(records, type) {
  return records.find((r) => r.type === type);
}

/** Every WILLINSTALL record as [file, engine], in order. */
function fileRecords(records) {
  return records.filter((r) => r.type === 'WILLINSTALL').map((r) => r.fields);
}

const DOC = {
  kind: 'tool',
  formatVersion: '3',
  id: 'my-tool',
  displayName: 'My Tool',
  type: 'editor-tool',
  description: 'Does a thing.',
  license: 'MIT',
  author: 'Someone',
  homepage: 'https://example.invalid',
  latest: '1.2.0',
  tags: ['editor', 'utility'],
  provides: ['my-tool.window.main'],
  injects: ['script.api.argument-guards'],
  dependencies: [
    { id: 'core-editor-utils', version: '^1.1.0', reason: 'Uses Guard.' },
    { id: 'libs-sharp-json', optional: true },
  ],
  files: ['Assets/MyTool/MyTool.cs'],
};

/** A stand-in for ToolManifest, mirroring the getters toolDetail reads. */
function model(overrides = {}) {
  return {
    version: '1.2.0',
    engines: ['unity'],
    tags: DOC.tags,
    entry: { releasedAt: '2026-01-15', yanked: false, notes: 'First release.' },
    // formatVersion 3 puts the declared inventory on the (version, engine) pair, not at the
    // top level, so the stand-in has to carry it there too.
    allTargets: [{ engine: 'unity', files: ['Assets/MyTool/MyTool.cs'] }],
    ...overrides,
  };
}

test('the version comes from the resolved release, not the raw document', () => {
  // The regression: the raw doc has no `version`, so this used to be empty.
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(details(records, 'version'), ['1.2.0']);
});

test('a pinned release reports its own version', () => {
  const records = capture(() => toolDetail(DOC, model({ version: '1.0.0' })));
  assert.deepEqual(details(records, 'version'), ['1.0.0']);
});

test('without a model the version degrades to latest, never to empty', () => {
  const records = capture(() => toolDetail(DOC, undefined));
  assert.deepEqual(details(records, 'version'), ['1.2.0']);
});

test('tags are emitted in the detail stream', () => {
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(details(records, 'tags'), ['editor,utility']);
});

test('release metadata comes from the version entry', () => {
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(details(records, 'releasedAt'), ['2026-01-15']);
  assert.deepEqual(details(records, 'notes'), ['First release.']);
  assert.deepEqual(details(records, 'yanked'), ['false']);
});

test('a yanked release says so', () => {
  const records = capture(() =>
    toolDetail(DOC, model({ entry: { releasedAt: '2026-01-15', yanked: true, notes: '' } })));
  assert.deepEqual(details(records, 'yanked'), ['true']);
});

test('absent release metadata is an empty field, not a missing record', () => {
  // The C# reader returns "" for an absent key and has no way to distinguish it from a
  // present-but-empty one, so emitting the record unconditionally is what keeps the two
  // honest. A missing record would make "no date" and "not reported" identical.
  const records = capture(() => toolDetail(DOC, model({ entry: null })));
  assert.deepEqual(details(records, 'releasedAt'), ['']);
  assert.deepEqual(details(records, 'notes'), ['']);
  assert.deepEqual(details(records, 'yanked'), ['false']);
});

test('capabilities and identity are still emitted', () => {
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(details(records, 'id'), ['my-tool']);
  assert.deepEqual(details(records, 'displayName'), ['My Tool']);
  assert.deepEqual(details(records, 'engines'), ['unity']);
  assert.deepEqual(details(records, 'provides'), ['my-tool.window.main']);
  assert.deepEqual(details(records, 'injects'), ['script.api.argument-guards']);
  assert.deepEqual(details(records, 'license'), ['MIT']);
  assert.deepEqual(details(records, 'author'), ['Someone']);
  assert.deepEqual(details(records, 'homepage'), ['https://example.invalid']);
  assert.deepEqual(details(records, 'deprecated'), ['false']);
});

test('documentation is reported apart from the homepage', () => {
  // Different places often enough that one cannot stand for both: a reader that only had
  // homepage had no way to offer a docs link at all.
  const records = capture(() => toolDetail(
    { ...DOC, documentation: 'https://example.invalid/docs/' },
    model(),
  ));
  assert.deepEqual(details(records, 'documentation'), ['https://example.invalid/docs/']);
  assert.deepEqual(details(records, 'homepage'), ['https://example.invalid']);
});

test('an undeclared documentation URI is an empty field, not a missing record', () => {
  // Absent must stay distinguishable from "this backend does not report documentation at
  // all": the C# reader returns "" for a key it never saw, so the record is always emitted.
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(details(records, 'documentation'), ['']);
});

test('release notes are a link target, reported like documentation', () => {
  // A registry cannot render a changelog: the maintainer's site can, and correct it after
  // publication. So the front end is given an address, not the text.
  const records = capture(() => toolDetail(
    { ...DOC, releaseNotes: 'https://example.invalid/releases/' },
    model(),
  ));
  assert.deepEqual(details(records, 'releaseNotes'), ['https://example.invalid/releases/']);
  // Undeclared is an empty field for the same reason as documentation.
  assert.deepEqual(details(capture(() => toolDetail(DOC, model())), 'releaseNotes'), ['']);
});

test('a dependency carries its constraint, optionality and reason', () => {
  const records = capture(() => toolDetail(DOC, model()));
  const dependencies = records.filter((r) => r.type === 'DEPENDENCY').map((r) => r.fields);
  assert.deepEqual(dependencies, [
    ['core-editor-utils', '^1.1.0', 'required', 'Uses Guard.', ''],
    ['libs-sharp-json', '', 'optional', '', ''],
  ]);
});

test('declared files are reported so the plan can be previewed', () => {
  // The regression: the inventory moved to versions[].targets.<engine>.artifact.files, so
  // reading the top-level `files` reported nothing and the editor's "Installs N file(s)"
  // section was always empty.
  const records = capture(() => toolDetail(DOC, model()));
  assert.equal(fileRecords(records).length, 1);
});

test('each declared file carries the engine it belongs to', () => {
  // Appended, so index 0 is still the file for a reader that only ever looked there.
  const records = capture(() => toolDetail(DOC, model()));
  assert.deepEqual(fileRecords(records), [['Assets/MyTool/MyTool.cs', 'unity']]);
});

test('a cross-engine tool reports each engine\'s inventory apart', () => {
  // Concatenating two engines' inventories would tell a Unity user that a Godot payload is
  // about to be written into Assets, which is false.
  const records = capture(() => toolDetail(DOC, model({
    engines: ['godot', 'unity'],
    allTargets: [
      { engine: 'godot', files: ['addons/my_tool/plugin.cfg'] },
      { engine: 'unity', files: ['Assets/MyTool/MyTool.cs'] },
    ],
  })));
  assert.deepEqual(fileRecords(records), [
    ['addons/my_tool/plugin.cfg', 'godot'],
    ['Assets/MyTool/MyTool.cs', 'unity'],
  ]);
});

test('a declaration with no engine is still reported, unqualified', () => {
  // No model means an older shaped document, or a caller that has not resolved a release.
  // Dropping the inventory would be the original bug; an empty engine field says "not tied
  // to one engine", which a front end may show for any engine.
  const records = capture(() => toolDetail(DOC, undefined));
  assert.deepEqual(fileRecords(records), [['Assets/MyTool/MyTool.cs', '']]);
});

test('the stream opens with its contract version', () => {
  const records = capture(() => meta('D:/reg'));
  assert.deepEqual(records[0].fields, ['recordsVersion', RECORDS_VERSION]);
  assert.deepEqual(records[1].fields, ['registry', 'D:/reg']);
});

test('a receipt reports which version is installed, in field 1', () => {
  // The front end reads field 1 to tell "installed" from "installed at an older release",
  // so the position is pinned rather than assumed.
  const records = capture(() => receipts([{
    toolId: 'my-tool',
    version: '1.0.0',
    artifactFormat: 'unitypackage',
    installedAtUtc: '2026-01-15T10:00:00Z',
    installedFiles: ['Assets/MyTool/MyTool.cs', 'Assets/MyTool/MyTool.cs.meta'],
  }]));

  const receipt = records.find((r) => r.type === 'RECEIPT');
  assert.equal(receipt.fields[0], 'my-tool');
  assert.equal(receipt.fields[1], '1.0.0');
  assert.equal(receipt.fields[2], 'unitypackage');
  assert.equal(receipt.fields[4], '2');

  // The listing-level count still comes from RESULT, which must stay readable after RESULT
  // stopped being skipped by the reader in the front end.
  const result = records.find((r) => r.type === 'RESULT');
  assert.deepEqual(result.fields, ['installed', '1']);
});

test('a TOOL record reports the version a listing can show', () => {
  const records = capture(() => toolSummaries([{
    id: 'my-tool',
    latest: '1.2.0',
    type: 'editor-tool',
    engines: ['unity'],
    provides: ['my-tool.window.main'],
    injects: [],
    displayName: 'My Tool',
    tags: ['editor'],
    dependencies: [{ id: 'core-editor-utils', version: '^1.1.0' }],
    manifestPath: 'payloads/my-tool/tool.yaml',
    versions: ['1.2.0', '1.0.0'],
  }]));

  // Field 1 is the version and field 2 is the type. Reading field 2 as a version was a
  // real defect in the front end, so the positions are pinned here.
  const tool = find(records, 'TOOL');
  assert.equal(tool.fields[0], 'my-tool');
  assert.equal(tool.fields[1], '1.2.0');
  assert.equal(tool.fields[2], 'editor-tool');
  assert.equal(tool.fields[6], 'My Tool');
  assert.equal(tool.fields[7], 'editor');
  assert.equal(tool.fields[8], 'core-editor-utils@^1.1.0');
  assert.equal(tool.fields[9], 'payloads/my-tool/tool.yaml');

  // VERSIONS is the only place that says which release is latest.
  const versions = records.filter((r) => r.type === 'VERSIONS').map((r) => r.fields);
  assert.deepEqual(versions, [
    ['my-tool', '1.2.0', 'latest'],
    ['my-tool', '1.0.0', ''],
  ]);
});

test('a target reports its engine floors and artifact', () => {
  const records = capture(() => toolTargets([{
    engine: 'unity',
    minEngineVersion: '2019.4',
    extraRequirements: { minRuntimeVersion: '4.6' },
    type: 'package',
    format: 'unitypackage',
    artifactPath: 'payloads/my-tool/artifacts/my-tool-1.2.0.unitypackage',
    contentRoot: '',
    targetPath: '',
    editorOnly: true,
    external: null,
  }]));

  const target = find(records, 'TARGET');
  assert.deepEqual(target.fields, [
    'unity',
    '2019.4',
    'minRuntimeVersion=4.6',
    'package',
    'unitypackage',
    'payloads/my-tool/artifacts/my-tool-1.2.0.unitypackage',
    '',
    '',
    'true',
    '',
    '',
  ]);
});

test('fields containing tabs or newlines are escaped to stay on one line', () => {
  const records = capture(() => toolDetail({ ...DOC, description: 'a\tb\nc' }, model()));
  // One record per line is the whole reason this format is parseable by a split, so a tab
  // in a description must travel as the two characters backslash-t. The reader reverses
  // this; asserting the WIRE form is what pins that guarantee.
  assert.deepEqual(details(records, 'description'), ['a\\tb\\nc']);

  // If a newline leaked into a field, splitting would produce an extra entry whose "type"
  // is a fragment of prose. Every type being an uppercase word is the invariant that a
  // leaked newline would break.
  for (const record of records) {
    assert.match(record.type, /^[A-Z]+$/, `bogus record type: ${JSON.stringify(record.type)}`);
  }
});

test('a plan reports where the tool lands, and where the caller moved it', () => {
  // The window shows the destination before writing, so both have to travel: the manifest's
  // own root (what happens with no choice) and the chosen one. Appended after the existing
  // fields so a reader that indexes the earlier ones keeps working.
  const records = capture(() => installPlan({
    tools: [{
      id: 'my-tool',
      version: '1.2.0',
      engine: 'unity',
      artifactType: 'archive',
      artifactFormat: 'zip',
      size: 10,
      sha256: 'a'.repeat(64),
      contentRoot: 'Assets',
      editorOnly: false,
      installedBecause: ['user'],
      skipped: null,
      installRoot: 'Assets/MyTool',
      into: 'Assets/Plugins/Mine',
      items: [{ path: 'Assets/Plugins/Mine/MyTool.cs', size: 10 }],
    }],
    totalBytes: 10,
    ok: true,
  }));

  const tool = find(records, 'PLANTOOL');
  assert.equal(tool.fields[11], 'Assets/MyTool');
  assert.equal(tool.fields[12], 'Assets/Plugins/Mine');
  // PLANFILE is what will exist on disk, not the path inside the archive.
  assert.deepEqual(find(records, 'PLANFILE').fields, ['my-tool', 'Assets/Plugins/Mine/MyTool.cs']);
});

test('an uninstall reports files that were already gone, and a directory that moved', () => {
  // Without these the window could only say "0 files removed", which is also what a clean
  // uninstall of an empty tool looks like. The difference is the whole point.
  const records = capture(() => uninstallPlan({
    delete: ['Assets/MovedTool/A.cs'],
    keep: [],
    alreadyGone: ['Assets/MovedTool/A.cs'],
    modified: [],
    vanishedRoots: [{ toolId: 'moved-tool', root: 'Assets/MovedTool' }],
  }));

  assert.deepEqual(find(records, 'REMOVE').fields, ['Assets/MovedTool/A.cs']);
  assert.deepEqual(find(records, 'ALREADYGONE').fields, ['Assets/MovedTool/A.cs']);
  assert.deepEqual(find(records, 'MOVEDROOT').fields, ['moved-tool', 'Assets/MovedTool']);
});
