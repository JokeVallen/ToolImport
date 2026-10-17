/**
 * Godot engine adapter.
 *
 * Note what is NOT here: a container handler. Godot addons ship as ordinary
 * archives, and the core already opens zip, tgz and tar.zst, so this adapter
 * contributes only engine knowledge:
 *
 *   - how to compare a Godot version
 *   - which requirement keys it owns
 *
 * That asymmetry with the Unity adapter is the point of the seam. An engine whose
 * packages are plain archives needs no new container code at all; an engine with a
 * proprietary package format (Unity's unitypackage) adds a handler and nothing else.
 * Either way the core is untouched.
 */

import { compareVersions } from '@toolimport/utool-core';

export const ENGINE = 'godot';

/** Requirement keys this adapter knows how to compare. */
export const KNOWN_REQUIREMENTS = Object.freeze(['minEngineVersion']);

/**
 * Compare two Godot versions.
 *
 * Godot versions are `major.minor[.patch]` with optional stability labels such as
 * `4.2.1-stable` or `4.3-beta3`. The numeric triple decides; the label does not,
 * which matches how the core compares tool versions and keeps the rule consistent.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareGodotVersions(a, b) {
  const normalise = (text) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text).trim());
    if (!match) {
      throw new TypeError(`not a valid Godot version: ${JSON.stringify(text)}`);
    }
    return `${match[1]}.${match[2]}.${match[3] ?? '0'}`;
  };
  return compareVersions(normalise(a), normalise(b));
}

export const godotAdapter = {
  engine: ENGINE,

  /**
   * No container handlers: Godot addons are plain archives the core already reads.
   * Declared explicitly rather than omitted so the intent is visible.
   */
  containerHandlers: [],

  /**
   * @param {string} engine
   * @param {string} requirement
   * @param {string|number|boolean} value
   * @param {{engineVersion?: string}} host
   * @returns {boolean|undefined} undefined when this adapter cannot judge the key
   */
  meetsRequirement(engine, requirement, value, host) {
    if (engine !== ENGINE) return undefined;

    switch (requirement) {
      case 'minEngineVersion': {
        if (!host?.engineVersion) return undefined;
        return compareGodotVersions(host.engineVersion, String(value)) >= 0;
      }
      default:
        // Not ours to judge. Say so rather than returning false, which would block
        // installs the moment an unfamiliar requirement key appears.
        return undefined;
    }
  },

  /**
   * @param {{godotVersion?: string}} input
   */
  hostFacts(input = {}) {
    return {
      engineVersion: input.godotVersion ?? null,
      // Godot has no separate API-compatibility level, so there is no runtime floor
      // to compare. Leaving it out means such a requirement is reported, not enforced.
      runtimeVersion: null,
    };
  },
};

export { ENGINE as GODOT_ENGINE };
