/**
 * End-to-end checks for the prose `show` output.
 *
 * WHY THIS EXISTS
 * ---------------
 * `show` had no test at all, and it crashed on every tool: the "installs" block read
 * `manifest.files`, a top-level field that formatVersion 3 moved onto
 * `versions[].targets.<engine>.artifact.files`. `manifest` is a typed model with no `files`
 * getter, so `undefined.length` threw and the command exited 1 - with the whole description
 * already printed above the error, which is why it looked like a formatting glitch rather
 * than a crash.
 *
 * These run the real CLI against the registry checkout, because the defect was in how the
 * command assembles its output, not in any function a unit test could call. They skip when no
 * registry is checked out, like the fixture tests in utool-core.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY, registryTest } from '../../../packages/utool-core/test/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bin', 'utool.js');

/** Run the CLI and capture what a user would see. */
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

/** Tool ids present in the registry checkout, read from the payload directories. */
function toolIds() {
  return readdirSync(path.join(REGISTRY, 'payloads'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('show succeeds for every tool in the registry', registryTest(), () => {
  // One crashing tool would be a bug; crashing on all of them is what a removed field looks
  // like, so this loops rather than picking one.
  for (const id of toolIds()) {
    const result = run(['show', id, '--registry', REGISTRY]);
    assert.equal(result.status, 0, `${id}: ${result.stderr}`);
  }
});

test('show lists the files a tool declares', registryTest(), () => {
  // A tool that declares an inventory must print it; before the fix every tool printed
  // nothing here, and `show` could not even finish.
  const withFiles = toolIds().find((id) => {
    try {
      return readFileSync(path.join(REGISTRY, 'payloads', id, 'tool.yaml'), 'utf8')
        .includes('files:');
    } catch {
      return false;
    }
  });
  assert.ok(withFiles, 'no tool in the registry declares an inventory to check');

  const result = run(['show', withFiles, '--registry', REGISTRY]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installs \d+ file\(s\)/);
});
