/**
 * The Node floor, and the way this package fails when it is not met.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The import tool claims a minimum Node version, and the claim was wrong for a release: zlib's
 * zstd codec arrived in 22.15, but the package said 20.11, and `containers.js` imported the
 * symbol by name. A named import is resolved when the module is LINKED - before any guard in that
 * module runs - so on an old Node the tool did not report a missing codec, it failed to load at
 * all, with a message from inside node:zlib that names neither the tool nor the version that
 * would fix it. The first CI run of the published starter registry is how it was found.
 *
 * Two things are therefore asserted here: the floor is what the code actually needs, and the
 * zstd symbol is reached in a way that leaves the guard reachable.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ZSTD_MIN_NODE } from '../src/index.js';

const source = readFileSync(new URL('../src/containers.js', import.meta.url), 'utf8');

/** The source with comments removed: the file EXPLAINS the bad import in a comment. */
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the declared zstd floor is the release that added the codec', () => {
  // v22.15.0 is where node:zlib gained zstdCompress/zstdDecompress. A lower claim is the bug this
  // file guards against; a higher one would reject Nodes that work.
  assert.equal(ZSTD_MIN_NODE, '22.15');
});

test('zstd is reached through the module namespace, not a named import', () => {
  // A named import of a symbol the running Node does not export aborts module linking, so the
  // "no zstd codec" guard never runs and the user gets node's own error instead.
  const namedZstdImport = /import\s*\{[^}]*zstd[^}]*\}\s*from\s*'node:zlib'/.test(codeOnly);
  assert.equal(namedZstdImport, false, 'containers.js must not import zstd by name from node:zlib');
  assert.match(codeOnly, /import \* as zlib from 'node:zlib'/);
});

test('a zstd artifact on a Node without the codec reports the version it needs', async () => {
  // The guard's message is the only thing a user on an old Node will see, so it has to name the
  // floor. Exercised through the public path: a .tar.zst artifact that must be inspected.
  const { createCoreContainerRegistry } = await import('../src/index.js');
  const registry = createCoreContainerRegistry();

  assert.equal(typeof registry, 'object');
  // On this test runner the codec exists; the message itself is checked by reading the source,
  // because faking its absence would mean replacing a Node built-in.
  assert.match(
    source,
    /\.tar\.zst needs Node \$\{ZSTD_MIN_NODE\} or newer/,
    'the missing-codec message must quote ZSTD_MIN_NODE',
  );
});
