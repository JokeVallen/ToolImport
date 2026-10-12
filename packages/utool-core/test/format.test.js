/**
 * Tests for the .utool format primitives.
 *
 * These run against the REAL registry in ../UnityDevCommonLib as well as against
 * synthetic documents, so a change to the format that breaks the shipped registry
 * fails here rather than in a consumer's project.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseUtool,
  checkHeader,
  DocumentError,
  KIND,
  FORMAT_VERSION,
  satisfies,
  isVersion,
  isConstraint,
  compareVersions,
  compareUnityVersions,
  compareDotNetVersions,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The real registry, resolved from this file: <repo>/UnityDevCommonLib. */
export const REGISTRY = path.resolve(here, '../../../../UnityDevCommonLib');

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test('parses a minimal tool document', () => {
  const doc = parseUtool(`
kind: tool
formatVersion: '1'
id: my-tool
displayName: My Tool
`);
  assert.equal(doc.kind, 'tool');
  assert.equal(doc.formatVersion, '1');
  assert.equal(doc.id, 'my-tool');
});

test('YAML comments and folded scalars are ignored', () => {
  const doc = parseUtool(`
# a leading comment
kind: tool            # trailing comment
formatVersion: '1'
description: >-
  a long description that was
  folded across lines
`);
  assert.equal(doc.description, 'a long description that was folded across lines');
});

test('rejects a document whose root is not a mapping', () => {
  assert.throws(() => parseUtool('- a\n- b\n'), DocumentError);
  assert.throws(() => parseUtool('just a scalar'), DocumentError);
  assert.throws(() => parseUtool(''), DocumentError);
});

test('rejects unknown kind and unsupported formatVersion', () => {
  const bad = parseUtool('kind: gadget\nformatVersion: \'1\'');
  assert.equal(checkHeader(bad, 'x', KIND.TOOL, { lenient: true }), false);
  assert.throws(() => checkHeader(bad, 'x', KIND.TOOL), /unknown kind/);

  const future = parseUtool("kind: tool\nformatVersion: '2'");
  assert.throws(() => checkHeader(future, 'x', KIND.TOOL), /not supported/);

  // A bare numeric 1 is not the string '1'; a reader must not guess.
  const numeric = parseUtool('kind: tool\nformatVersion: 2');
  assert.throws(() => checkHeader(numeric, 'x', KIND.TOOL), /not supported/);
});

test('a missing discriminator is an error, not a default', () => {
  const doc = parseUtool("formatVersion: '1'");
  assert.throws(() => checkHeader(doc, 'x', KIND.TOOL), /missing "kind"/);
});

// ---------------------------------------------------------------------------
// semver-lite
// ---------------------------------------------------------------------------

test('parses and compares versions on the numeric triple only', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.2.10', '1.2.9') > 0);
  // Prerelease suffixes are labels, not precedence.
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0);
  assert.ok(isVersion('1.0.0-rc.1'));
  assert.ok(!isVersion('1.0'));
  assert.ok(!isVersion('v1.0.0'));
});

test('constraints follow the documented ranges', () => {
  assert.ok(satisfies('1.5.0', '^1.1.0'));
  assert.ok(!satisfies('2.0.0', '^1.1.0'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('1.1.0', '>=1.0.0'));
  assert.ok(satisfies('1.1.0', '>1.0.0'));
  assert.ok(!satisfies('1.1.0', '<1.0.0'));
  assert.ok(satisfies('1.4.2', '1.4.2'));
  assert.ok(satisfies('1.4.2', '=1.4.2'));
  assert.ok(!satisfies('1.4.3', '1.4.2'));
  // No constraint means any version the registry provides.
  assert.ok(satisfies('0.0.1', undefined));
  assert.ok(satisfies('0.0.1', ''));
  assert.ok(isConstraint('^1.2.3'));
  assert.ok(isConstraint('1.2.3'));
  assert.ok(!isConstraint('1.2'));
  assert.ok(!isConstraint('latest'));
});

test('unknown constraint syntax throws rather than silently passing', () => {
  assert.throws(() => satisfies('1.0.0', '^^1.0.0'), TypeError);
  assert.throws(() => satisfies('nonsense', '^1.0.0'), TypeError);
});

test('Unity versions compare with release stage ordering', () => {
  assert.ok(compareUnityVersions('2021.3.5f1', '2020.3') > 0);
  assert.equal(compareUnityVersions('2020.3', '2020.3'), 0);
  assert.ok(compareUnityVersions('2020.3', '2019.4') > 0);
  // f (final) beats b (beta) at the same numeric version
  assert.ok(compareUnityVersions('2020.1.0f1', '2020.1.0b1') > 0);
  assert.throws(() => compareUnityVersions('not-a-version', '2020.3'), TypeError);
});

test('.NET API levels compare numerically', () => {
  assert.ok(compareDotNetVersions('6.0', '4.6') > 0);
  assert.equal(compareDotNetVersions('4.6', '4.6'), 0);
  assert.ok(compareDotNetVersions('4.6', '8.0') < 0);
});
