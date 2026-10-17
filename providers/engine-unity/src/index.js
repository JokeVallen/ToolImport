/**
 * Unity engine adapter.
 *
 * Everything Unity-specific lives here rather than in the core:
 *
 *   container formats   unitypackage
 *   requirement rules   how to compare a Unity editor version, and how to compare
 *                       the .NET API compatibility level
 *   host facts          what the front end reports about the running editor
 *
 * THE IMPORTANT PART: `meetsRequirement` returns `undefined` for a requirement key
 * it does not understand, rather than `false`. The core treats `undefined` as "this
 * adapter cannot judge that key" and reports the floor without enforcing it. An
 * adapter that returned `false` for unknown keys would silently block installs the
 * moment someone adds a requirement key it has not been taught yet.
 */

import { compareDotNetVersions, compareUnityVersions } from '@toolimport/utool-core';
import { unitypackageHandler, UNITYPACKAGE_FORMAT } from './unitypackage.js';

export const ENGINE = 'unity';

/** Requirement keys this adapter knows how to compare. */
export const KNOWN_REQUIREMENTS = Object.freeze(['minEngineVersion', 'minRuntimeVersion']);

/**
 * Unity version floors: `minEngineVersion` is the editor version, compared with
 * the same release-stage ordering Unity uses (a < b < f < p).
 */
export const unityAdapter = {
  engine: ENGINE,

  /** Container formats this adapter teaches the core. */
  containerHandlers: [unitypackageHandler],

  /**
   * Does the host satisfy one declared requirement?
   *
   * @param {string} engine
   * @param {string} requirement key from the target's `requirements`
   * @param {string|number|boolean} value the declared floor
   * @param {{engineVersion?: string, runtimeVersion?: string}} host
   * @returns {boolean|undefined} undefined when this adapter cannot judge the key
   */
  meetsRequirement(engine, requirement, value, host) {
    if (engine !== ENGINE) return undefined;

    switch (requirement) {
      case 'minEngineVersion': {
        if (!host?.engineVersion) return undefined;
        return compareUnityVersions(host.engineVersion, String(value)) >= 0;
      }
      case 'minRuntimeVersion': {
        if (!host?.runtimeVersion) return undefined;
        return compareDotNetVersions(host.runtimeVersion, String(value)) >= 0;
      }
      default:
        // Not ours to judge. Say so instead of guessing.
        return undefined;
    }
  },

  /**
   * Describe the host from whatever the caller knows.
   *
   * The Unity editor front end knows both values exactly and passes them in.
   * A shell caller usually knows only the editor version, from
   * ProjectSettings/ProjectVersion.txt; the .NET level is a project setting this
   * adapter cannot read from disk reliably, so it stays undefined and that
   * particular floor is then reported rather than enforced.
   *
   * @param {{unityVersion?: string, dotNetVersion?: string}} input
   */
  hostFacts(input = {}) {
    return {
      engineVersion: input.unityVersion ?? null,
      runtimeVersion: input.dotNetVersion ?? null,
    };
  },
};

export { unitypackageHandler, UNITYPACKAGE_FORMAT };
