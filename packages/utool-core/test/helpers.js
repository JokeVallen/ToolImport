/**
 * Shared test helpers.
 *
 * The important helper is `makeContainers`: every test that touches a Unity
 * payload must register the Unity adapter first, because the core deliberately
 * does not know what a unitypackage is. A test that forgets gets a clear
 * "no handler registered" error rather than a false pass.
 */

import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createCoreContainerRegistry,
  verifyArtifactBytes,
} from '../src/index.js';
import { unityAdapter } from '../../../providers/engine-unity/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate a registry checkout to run the fixture-based tests against.
 *
 * Resolution order:
 *   1. UTOOL_TEST_REGISTRY, for a layout this cannot guess;
 *   2. a sibling directory that looks like a registry (index.yaml + payloads/).
 *
 * The name is deliberately not hardcoded. `ToolRegistry` was assumed by
 * path before, so renaming or relocating the data repository broke the tests with
 * `E-INDEX-MISSING` -- a message about the registry's contents, when the real
 * problem was that the path no longer existed. A registry is identified by its
 * SHAPE here for the same reason the CLI identifies one that way.
 *
 * @returns {string|null} absolute path, or null when none is present.
 */
function findRegistry() {
  const fromEnvironment = process.env.UTOOL_TEST_REGISTRY;
  if (fromEnvironment) return fromEnvironment;

  const looksLikeRegistry = (candidate) =>
    existsSync(path.join(candidate, 'index.yaml')) && existsSync(path.join(candidate, 'payloads'));

  // Only the immediate siblings of the repository root are considered, and only
  // when the repository root is itself a git checkout of the importer.
  //
  // Scanning further up was a mistake: it reached the system temp directory and
  // adopted any unrelated directory that happened to hold an index.yaml and a
  // payloads folder (a leftover probe did exactly that), silently running the
  // fixture tests against the wrong data. The template/ directory was picked up the
  // same way in the CLI. A registry is identified by shape, but the SEARCH has to
  // stay close enough that a match is plausibly this project's data repository.
  const repoRoot = path.resolve(here, '..', '..', '..');
  if (!existsSync(path.join(repoRoot, '.git')) && !existsSync(path.join(repoRoot, 'package.json'))) {
    return null;
  }

  const parent = path.dirname(repoRoot);
  let entries = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .filter(looksLikeRegistry)
    // A registry declares itself in index.yaml; require the kind so a stray
    // directory cannot masquerade as one.
    .filter((candidate) => {
      try {
        return readFileSync(path.join(candidate, 'index.yaml'), 'utf8').includes('kind: index');
      } catch {
        return false;
      }
    })
    .sort();

  if (matches.length > 0) return matches[0];

  // The repository root may itself contain the registry (single-repo layout).
  return looksLikeRegistry(repoRoot) ? repoRoot : null;
}

/** The registry these tests run against, or null when none is checked out. */
export const REGISTRY = findRegistry();

/** True when a registry is available; fixture tests skip themselves when not. */
export const HAS_REGISTRY = REGISTRY !== null;

/**
 * Test options that skip a registry-dependent test when no registry is checked out.
 *
 * Skipping is right rather than failing: without the data repository there is
 * nothing to test, and a failure here reads as broken code. The check still runs in
 * CI, where the sibling checkout exists, and `npm test` says plainly what it skipped.
 *
 * @param {string} [reason]
 */
export function registryTest(reason = 'no registry checkout found') {
  return HAS_REGISTRY
    ? {}
    : { skip: `${reason} (set UTOOL_TEST_REGISTRY to a registry path to run this)` };
}

/** A core container registry with the Unity adapter loaded. */
export function makeContainers() {
  const containers = createCoreContainerRegistry();
  for (const handler of unityAdapter.containerHandlers) {
    containers.register(handler);
  }
  return containers;
}

/** A core container registry with NO engine adapter, for decoupling tests. */
export function makeCoreOnlyContainers() {
  return createCoreContainerRegistry();
}

export { verifyArtifactBytes };
