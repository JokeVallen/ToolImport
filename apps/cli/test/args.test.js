/**
 * Argument parser checks.
 *
 * The bug these exist for: `--also-engine godot` was parsed as `--also-engine g`,
 * because the repeatable flag was not recognised as value-taking and the next token
 * was therefore treated as a positional. The engine name silently lost its first
 * character, and the failure surfaced later as "no adapter for engine 'g'".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../lib/args.js';

test('a plain value flag consumes its value', () => {
  const { command, positionals, flags, unknown } = parseArgs(['install', 'my-tool', '--registry', '../Reg']);
  assert.equal(command, 'install');
  assert.deepEqual(positionals, ['my-tool']);
  assert.equal(flags.registry, '../Reg');
  assert.deepEqual(unknown, []);
});

test('--flag=value works for a plain flag', () => {
  const { flags } = parseArgs(['list', '--registry=../Reg']);
  assert.equal(flags.registry, '../Reg');
});

test('boolean flags do not consume the next token', () => {
  const { command, positionals, flags } = parseArgs(['install', '--dry-run', 'my-tool']);
  assert.equal(command, 'install');
  assert.deepEqual(positionals, ['my-tool'], 'my-tool must stay a positional');
  assert.equal(flags.dryRun, true);
});

test('a repeatable flag keeps the whole value, not its tail', () => {
  // This is the regression: 'godot' used to become 'g'.
  const { positionals, flags } = parseArgs([
    'install', 'core-editor-utils',
    '--engine', 'unity',
    '--also-engine', 'godot',
  ]);
  assert.equal(flags.engine, 'unity');
  assert.deepEqual(flags.alsoEngine, ['godot']);
  assert.deepEqual(positionals, ['core-editor-utils']);
});

test('a repeatable flag accumulates every occurrence', () => {
  const { flags } = parseArgs([
    'install', 'tool',
    '--also-engine', 'godot',
    '--also-engine', 'unreal',
    '--also-engine=defold',
  ]);
  assert.deepEqual(flags.alsoEngine, ['godot', 'unreal', 'defold']);
});

test('the list filters parse, and the engine filter is distinct from --engine', () => {
  const { flags } = parseArgs([
    'list',
    '--tag', 'editor',
    '--tag', 'workflow',
    '--provides', 'script.api.argument-guards',
    '--depends-on', 'core-editor-utils',
    '--engine-filter', 'godot',
    '--search', 'Editor',
  ]);

  assert.deepEqual(flags.tag, ['editor', 'workflow']);
  assert.deepEqual(flags.provides, ['script.api.argument-guards']);
  // A hyphenated flag must map to camelCase, or the filter would silently never apply.
  assert.deepEqual(flags.dependsOn, ['core-editor-utils']);
  // Two different questions: which engine to install into, versus which engines a tool
  // supports. Collapsing them would make `list --engine godot` ambiguous.
  assert.equal(flags.engineFilter, 'godot');
  assert.equal(flags.engine, undefined);
  assert.equal(flags.search, 'Editor');
});

test('a value flag with no value is reported as unknown, not silently emptied', () => {
  // '--registry' followed by another flag means someone forgot the value.
  const { flags, unknown } = parseArgs(['list', '--registry', '--json']);
  assert.equal(flags.registry, undefined);
  assert.deepEqual(unknown, ['--registry']);
  assert.equal(flags.json, true);
});

test('-- terminates flag parsing', () => {
  const { positionals } = parseArgs(['show', '--', '--not-a-flag']);
  assert.deepEqual(positionals, ['--not-a-flag']);
});

test('single-dash help and version are recognised', () => {
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('hyphenated flags map to camelCase keys', () => {
  const { flags } = parseArgs(['install', 'tool', '--host-unity', '2021.3.5f1', '--no-hash']);
  assert.equal(flags.hostUnity, '2021.3.5f1');
  assert.equal(flags.noHash, true);
  assert.equal(flags.hostunity, undefined, 'the key must be camelCase, not lowercased');
});
