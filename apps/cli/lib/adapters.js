/**
 * Engine adapter loading.
 *
 * The core ships with no engine. A caller that wants Unity payloads must load the
 * Unity adapter, and this module is the one place that decides which adapters exist.
 * Keeping the list here rather than inside the core is the point: the core cannot
 * grow an engine dependency by accident.
 *
 * Adapters are imported dynamically so a caller that only deals with general
 * archives never pays for, or depends on, an engine package.
 */

import { createCoreContainerRegistry } from '@unitydevcommonlib/utool-core';

/**
 * Known adapters, by engine name. Each entry lazily imports its package.
 *
 * Adding an engine means adding one line here plus a `providers/engine-<name>`
 * package. No core file changes.
 */
const ADAPTERS = {
  unity: () => import('@devcat/provider-engine-unity'),
};

/** @returns {string[]} engine names this build can serve */
export function knownEngines() {
  return Object.keys(ADAPTERS).sort();
}

/**
 * Load one engine adapter.
 *
 * @param {string} engine
 * @returns {Promise<{engine: string, containerHandlers: object[], meetsRequirement: Function, hostFacts: Function}>}
 */
export async function loadAdapter(engine) {
  const loader = ADAPTERS[engine];
  if (!loader) {
    throw new Error(
      `no adapter for engine '${engine}'. Known engines: ${knownEngines().join(', ')}. ` +
        `An engine without an adapter is still valid registry data - it simply cannot be planned.`,
    );
  }
  const module = await loader();
  // Each adapter package exports `<engine>Adapter`.
  const adapter = module[`${engine}Adapter`] ?? Object.values(module).find((v) => v?.engine === engine);
  if (!adapter) {
    throw new Error(`adapter package for '${engine}' does not export a matching adapter object`);
  }
  return adapter;
}

/**
 * Build a container registry with the named adapters loaded.
 *
 * @param {string[]} engines
 * @returns {Promise<{containers: import('@unitydevcommonlib/utool-core').ContainerRegistry, adapters: Map<string, object>}>}
 */
export async function loadAdapters(engines) {
  const containers = createCoreContainerRegistry();
  const adapters = new Map();

  for (const engine of engines) {
    const adapter = await loadAdapter(engine);
    for (const handler of adapter.containerHandlers ?? []) {
      containers.register(handler);
    }
    adapters.set(engine, adapter);
  }

  return { containers, adapters };
}

/**
 * Build a floor comparator over the loaded adapters.
 *
 * The resolver asks one question per (engine, requirement) pair. Routing it here
 * keeps the core free of engine knowledge while letting each adapter answer for
 * its own keys - and answer `undefined` when a key is not its business.
 *
 * @param {Map<string, object>} adapters
 * @param {Record<string, {engineVersion?: string, runtimeVersion?: string}>} hostByEngine
 * @returns {(engine: string, requirement: string, value: unknown) => boolean|undefined}
 */
export function createRequirementChecker(adapters, hostByEngine = {}) {
  return (engine, requirement, value) => {
    const adapter = adapters.get(engine);
    if (!adapter) return undefined;
    const host = hostByEngine[engine];
    if (!host) return undefined;
    return adapter.meetsRequirement(engine, requirement, value, host);
  };
}
