/**
 * The version has one home: package.json. Everything else reports it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The CLI printed a hardcoded `utool 0.1.0`, which is the version string a user quotes in a bug
 * report and the one a release is named after. A release is exactly when a stale copy is costly:
 * the tarball says 1.0.0 and `--version` says something else, and neither is obviously wrong.
 * Reading package.json removes the copy; this test keeps the workspace packages in step, because
 * a workspace that disagrees with its root is a release built from two versions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

function versionOf(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8')).version;
}

test('the CLI reports the version its package declares', () => {
  // The regression: a literal in bin/utool.js, which no release step could keep honest.
  const stdout = execFileSync(process.execPath, [path.join(root, 'apps', 'cli', 'bin', 'utool.js'), '-v'], {
    encoding: 'utf8',
  });
  assert.equal(stdout.trim(), `utool ${versionOf('apps/cli/package.json')}`);
});

test('every workspace package carries the same version', () => {
  // A workspace whose members disagree produces a release whose parts claim different versions.
  const expected = versionOf('package.json');
  for (const relative of [
    'apps/cli/package.json',
    'packages/utool-core/package.json',
    'providers/engine-unity/package.json',
    'providers/engine-godot/package.json',
  ]) {
    assert.equal(versionOf(relative), expected, `${relative} disagrees with the root package.json`);
  }
});
