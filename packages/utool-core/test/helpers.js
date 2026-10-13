/**
 * Shared test helpers.
 *
 * The important helper is `makeContainers`: every test that touches a Unity
 * payload must register the Unity adapter first, because the core deliberately
 * does not know what a unitypackage is. A test that forgets gets a clear
 * "no handler registered" error rather than a false pass.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCoreContainerRegistry,
  verifyArtifactBytes,
} from '../src/index.js';
import { unityAdapter } from '../../../providers/engine-unity/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The real registry, resolved from this file: <repo>/DevCatToolRegistry. */
export const REGISTRY = path.resolve(here, '../../../../DevCatToolRegistry');

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
