/**
 * Dependency resolution.
 *
 * Input: the ids the user asked for (plus, optionally, what is already installed)
 * Output: a topologically ordered install plan, or a structured list of problems.
 *
 * Rules enforced here (docs/SPEC.zh-CN.md section 4.1 and
 * docs/FRONTEND-INTEGRATION.zh-CN.md section 5):
 *   - required dependencies are pulled in transitively
 *   - optional dependencies resolve only when the user already selected them,
 *     and never make a plan fail
 *   - a cycle is a hard error, never auto-broken
 *   - the host must meet minUnityVersion / minDotNetVersion, and the failure
 *     names both the floor and which tool imposed it
 *
 * Problems are collected rather than thrown, so the UI can show every reason a
 * selection cannot be installed instead of only the first.
 */

import { ResolutionError, PlatformError } from './errors.js';
import { satisfies, compareUnityVersions, compareDotNetVersions } from './semver.js';
import { toManifest, ToolManifest } from './manifest.js';

/**
 * @typedef {Object} ResolveOptions
 * @property {{unityVersion: string, dotNetVersion: string}} [host]
 *   host capabilities; when omitted, platform gating is skipped entirely
 * @property {string[]} [alreadySelected] ids the user picked, used to decide
 *   whether an optional dependency applies
 * @property {(id: string) => boolean} [isInstalled] already-installed ids are
 *   still resolved but marked as such
 */

/**
 * @typedef {Object} PlanStep
 * @property {import('./manifest.js').ToolManifest} manifest
 * @property {string[]} installedBecause ids that required this, or ['user']
 * @property {boolean} alreadyInstalled
 * @property {boolean} external
 */

/**
 * @typedef {Object} Plan
 * @property {PlanStep[]} steps topological order: dependencies first
 * @property {{code: string, message: string, toolId?: string}[]} problems
 * @property {number} exitCode 0 when installable
 */

/**
 * Resolve a selection into an install plan.
 *
 * @param {string[]} requestedIds
 * @param {(id: string) => Promise<import('./manifest.js').ToolManifest>} fetchManifest
 * @param {ResolveOptions} [options]
 * @returns {Promise<Plan>}
 */
export async function resolveSelection(requestedIds, fetchManifest, options = {}) {
  const { host, isInstalled, alreadySelected } = options;
  const selected = new Set(alreadySelected ?? requestedIds);

  /** @type {Map<string, import('./manifest.js').ToolManifest>} */
  const manifests = new Map();
  /** @type {Map<string, Set<string>>} id -> ids that required it */
  const requiredBy = new Map();
  /** @type {{code: string, message: string, toolId?: string}[]} */
  const problems = [];
  /** @type {string[]} */
  const order = [];

  const seen = new Set();
  const inProgress = new Set();

  /** @param {string} id @param {string} neededBy */
  const visit = async (id, neededBy) => {
    if (!requiredBy.has(id)) requiredBy.set(id, new Set());
    if (neededBy !== 'user') requiredBy.get(id).add(neededBy);

    if (seen.has(id)) return;

    // Cycle detection runs on the DFS stack, before memoisation, so that a
    // back-edge is reported rather than silently tolerated.
    if (inProgress.has(id)) {
      const cycle = `${[...inProgress].join(' -> ')} -> ${id}`;
      problems.push({
        code: 'E-DEP-CYCLE',
        message: `dependency cycle detected: ${cycle}`,
        toolId: id,
      });
      return;
    }

    inProgress.add(id);
    let manifest;
    try {
      // fetchManifest may hand back a raw document or an already-normalised
      // manifest; toManifest handles both, so do not normalise twice here.
      manifest = await fetchManifest(id);
    } catch (cause) {
      problems.push({
        code: cause.code ?? 'E-DEP-FETCH',
        message: `cannot resolve '${id}': ${cause.message}`,
        toolId: id,
      });
      inProgress.delete(id);
      return;
    }

    // Identity check: the manifest must agree with what we asked for.
    if (manifest.id !== id) {
      problems.push({
        code: 'E-ID-MISMATCH',
        message: `asked for '${id}' but the manifest declares '${manifest.id}'`,
        toolId: id,
      });
    }

    manifests.set(id, manifest);
    checkPlatform(manifest, host, problems);

    for (const dep of manifest.dependencies) {
      if (dep.optional && !selected.has(dep.id)) continue;

      const target = manifests.get(dep.id) ?? (await safeFetch(dep.id, fetchManifest, problems));
      if (!target) continue;

      if (!satisfiesSafely(target.version, dep.version, dep.id, id, problems)) continue;

      await visit(dep.id, id);
    }

    inProgress.delete(id);
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };

  for (const id of requestedIds) {
    await visit(id, 'user');
  }

  const steps = order.map((id) => {
    const manifest = manifests.get(id);
    const because = [...(requiredBy.get(id) ?? new Set())];
    return {
      manifest,
      installedBecause: because.length > 0 ? because.sort() : ['user'],
      alreadyInstalled: isInstalled ? isInstalled(id) : false,
      external: manifest.isExternal,
    };
  });

  const exitCode = exitCodeFor(problems);
  return { steps, problems, exitCode };
}

/** @returns {Promise<import('./manifest.js').ToolManifest|null>} */
async function safeFetch(id, fetchManifest, problems) {
  try {
    const manifest = await fetchManifest(id);
    return manifest instanceof ToolManifest ? manifest : toManifest(manifest);
  } catch (cause) {
    problems.push({
      code: cause.code ?? 'E-DEP-FETCH',
      message: `dependency '${id}' cannot be resolved: ${cause.message}`,
      toolId: id,
    });
    return null;
  }
}

/**
 * @returns {boolean} true when the constraint holds and no problem was recorded
 */
function satisfiesSafely(version, constraint, depId, dependentId, problems) {
  try {
    if (satisfies(version, constraint)) return true;
  } catch (cause) {
    problems.push({
      code: 'E-DEP-CONSTRAINT',
      message: `${dependentId} declares an invalid constraint for ${depId}: ${cause.message}`,
      toolId: dependentId,
    });
    return false;
  }
  problems.push({
    code: 'E-DEP-VERSION',
    message:
      `${dependentId} requires ${depId} ${constraint ?? '*'} but the registry provides ${version}`,
    toolId: dependentId,
  });
  return false;
}

/**
 * Enforce the declared platform floors.
 *
 * @param {import('./manifest.js').ToolManifest} manifest
 * @param {{unityVersion: string, dotNetVersion: string}|undefined} host
 * @param {{code: string, message: string, toolId?: string}[]} problems
 */
export function checkPlatform(manifest, host, problems) {
  if (!host) return;

  if (host.unityVersion !== undefined && host.unityVersion !== null) {
    try {
      if (compareUnity(host.unityVersion, manifest.minUnityVersion) < 0) {
        problems.push({
          code: 'E-PLATFORM-UNITY',
          message:
            `${manifest.id} needs Unity ${manifest.minUnityVersion} or newer, ` +
            `but this project runs ${host.unityVersion}`,
          toolId: manifest.id,
        });
      }
    } catch (cause) {
      problems.push({
        code: 'E-PLATFORM-PARSE',
        message: `${manifest.id}: ${cause.message}`,
        toolId: manifest.id,
      });
    }
  }

  if (host.dotNetVersion !== undefined && host.dotNetVersion !== null) {
    try {
      if (compareDotNet(host.dotNetVersion, manifest.minDotNetVersion) < 0) {
        problems.push({
          code: 'E-PLATFORM-DOTNET',
          message:
            `${manifest.id} needs .NET API level ${manifest.minDotNetVersion} or newer, ` +
            `but this project is set to ${host.dotNetVersion}`,
          toolId: manifest.id,
        });
      }
    } catch (cause) {
      problems.push({
        code: 'E-PLATFORM-PARSE',
        message: `${manifest.id}: ${cause.message}`,
        toolId: manifest.id,
      });
    }
  }
}

// Thin wrappers so a parse failure surfaces as a problem entry rather than an
// exception escaping the resolver.
function compareUnity(host, floor) {
  return compareUnityVersions(host, floor);
}
function compareDotNet(host, floor) {
  return compareDotNetVersions(host, floor);
}

/** @returns {number} the CLI exit code implied by a problem list */
export function exitCodeFor(problems) {
  if (problems.length === 0) return 0;
  if (problems.some((p) => p.code.startsWith('E-PLATFORM'))) return 4;
  return 3;
}

export { ResolutionError, PlatformError };
