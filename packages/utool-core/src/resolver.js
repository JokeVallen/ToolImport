/**
 * Dependency and capability resolution.
 *
 * Input: the ids the user asked for, and which engine they are installing into.
 * Output: a topologically ordered plan, or a structured list of problems.
 *
 * Rules, from docs/SPEC.zh-CN.md and docs/FRONTEND-INTEGRATION.zh-CN.md:
 *   - a tool must declare a target for the requested engine, or it is skipped
 *     with a reason rather than silently dropped
 *   - requirements are checked against the host, and a failure names both the
 *     floor and the tool that imposed it
 *   - required dependencies are pulled in transitively; optional ones only when
 *     the user already selected them
 *   - a cycle is a hard error, never auto-broken
 *   - a capability may have at most one provider in the plan, and every inject
 *     must be satisfiable. Both are errors, because either way a consumer cannot
 *     know what it received.
 *
 * Problems are collected rather than thrown, so a UI can show every reason a
 * selection cannot be installed instead of only the first.
 */

import { PlatformError, ResolutionError } from './errors.js';
import { compareVersions, satisfies } from './semver.js';
import { toManifest, ToolManifest } from './manifest.js';

/**
 * @typedef {Object} ResolveOptions
 * @property {string} [engine] engine being installed into; defaults to unity,
 *   because that is the adapter this tool ships with
 * @property {string[]} [alsoEngines] extra engines to plan at the same time, for a
 *   cross-engine install of a shared C# library
 * @property {(engine: string, requirement: string, value: string|number|boolean) => boolean} [meetsRequirement]
 *   engine-specific floor comparison, supplied by the adapter
 * @property {string[]} [alreadySelected]
 * @property {(id: string) => boolean} [isInstalled]
 * @property {boolean} [autoResolveInjects] when true, an `injects` entry with no
 *   provider in the plan may have one selected for it. Off by default: silently
 *   adding a tool the user did not ask for is worse than explaining the gap.
 * @property {(capability: string) => Promise<(string|{id: string})[]>} [listProviders]
 *   which tools advertise a capability. Supplied by the caller so the core need not
 *   hold an index or a source.
 */

export const DEFAULT_ENGINE = 'unity';

/**
 * Resolve a selection into an install plan.
 *
 * @param {string[]} requestedIds
 * @param {(id: string) => Promise<ToolManifest|Record<string, any>>} fetchManifest
 * @param {ResolveOptions} [options]
 * @returns {Promise<{steps: object[], problems: object[], skipped: object[], exitCode: number}>}
 */
export async function resolveSelection(requestedIds, fetchManifest, options = {}) {
  const {
    engine = DEFAULT_ENGINE,
    alsoEngines = [],
    meetsRequirement,
    alreadySelected,
    isInstalled,
  } = options;

  // Every engine this plan touches. `engine` is primary: a tool that does not
  // support it is skipped rather than quietly installed somewhere else.
  const engines = [...new Set([engine, ...alsoEngines])];
  const selected = new Set(alreadySelected ?? requestedIds);

  /** @type {Map<string, ToolManifest>} */
  const manifests = new Map();
  /** @type {Map<string, Set<string>>} id -> ids that required it */
  const requiredBy = new Map();
  /** @type {object[]} */
  const problems = [];
  /** @type {object[]} */
  const skipped = [];
  /** @type {string[]} */
  const order = [];
  /**
   * Which version was chosen for each constrained dependency, and what else was
   * available. Only meaningful once a tool publishes more than one version, but
   * collected always so the plan can state it without a second pass.
   * @type {object[]}
   */
  const dependencyChoices = [];
  /**
   * The concrete version each tool in the plan should install. Populated by dependency
   * constraints as they are read, and consulted when the steps are built, so a
   * constraint that names an older version actually installs that version.
   * @type {Map<string, string>}
   */
  const versionsRequested = new Map();
  /**
   * Versions the USER named explicitly, as opposed to versions a dependency constraint
   * narrowed to. The distinction matters twice: an explicit request may reach a yanked
   * release, and an explicit request that cannot be honoured must be reported rather than
   * quietly swapped for a different version.
   * @type {Map<string, string>}
   */
  const userPinned = new Map();

  const seen = new Set();
  const inProgress = new Set();

  const visit = async (id, neededBy) => {
    if (!requiredBy.has(id)) requiredBy.set(id, new Set());
    if (neededBy !== 'user') requiredBy.get(id).add(neededBy);
    if (seen.has(id)) return;

    if (inProgress.has(id)) {
      problems.push({
        code: 'E-DEP-CYCLE',
        message: `dependency cycle detected: ${[...inProgress].join(' -> ')} -> ${id}`,
        toolId: id,
      });
      return;
    }

    inProgress.add(id);

    let manifest;
    try {
      const fetched = await fetchManifest(id);
      manifest = fetched instanceof ToolManifest ? fetched : toManifest(fetched);
    } catch (cause) {
      problems.push({
        code: cause.code ?? 'E-DEP-FETCH',
        message: `cannot resolve '${id}': ${cause.message}`,
        toolId: id,
      });
      inProgress.delete(id);
      return;
    }

    if (manifest.id !== id) {
      problems.push({
        code: 'E-ID-MISMATCH',
        message: `asked for '${id}' but the manifest declares '${manifest.id}'`,
        toolId: id,
      });
    }

    // --- engine applicability -------------------------------------------
    const usableEngines = engines.filter((candidate) => manifest.supports(candidate));
    if (usableEngines.length === 0) {
      skipped.push({
        id,
        reason:
          `does not support ${engines.join(' or ')}; it declares ` +
          `${manifest.engines.join(', ') || 'no targets'}`,
        availableEngines: manifest.engines,
      });
      inProgress.delete(id);
      seen.add(id);
      return;
    }

    manifests.set(id, manifest);

    for (const candidate of usableEngines) {
      checkRequirements(manifest, candidate, meetsRequirement, problems);
    }

    for (const dep of manifest.dependenciesFor(engine)) {
      if (dep.optional && !selected.has(dep.id)) continue;

      const target = manifests.get(dep.id) ?? (await safeFetch(dep.id, fetchManifest, problems));
      if (!target) continue;

      // A manifest now publishes several versions, so a constraint picks one. The
      // chosen version has to be remembered and planned from, because reading the
      // manifest's default could install a version the constraint excluded.
      const chosen = resolveDependencyVersion(
        target, dep, id, problems, dependencyChoices, versionsRequested,
      );
      if (!chosen) continue;

      await visit(dep.id, id);
    }

    inProgress.delete(id);
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };

  for (const id of requestedIds) {
    // An explicit `id@version` request pins that version for the whole plan, before
    // any dependency constraint narrows it further.
    const at = id.indexOf('@');
    if (at > 0) {
      const bare = id.slice(0, at);
      const wanted = id.slice(at + 1);
      if (wanted) {
        versionsRequested.set(bare, wanted);
        userPinned.set(bare, wanted);
      }
      await visit(bare, 'user');
    } else {
      await visit(id, 'user');
    }
  }

  // Capability-driven providers, when the caller allows the resolver to choose.
  // This must happen BEFORE the capability check below, because choosing a provider
  // is precisely what makes an inject satisfiable.
  const providerChoices = [];
  if (options.autoResolveInjects) {
    await resolveInjectedCapabilities({
      manifests, order, engine, engines, fetchManifest, requiredBy,
      listProviders: options.listProviders ?? (async () => []),
      providerChoices, problems,
    });
  }

  checkCapabilities(manifests, order, problems, skipped);

  const steps = order
    .filter((id) => manifests.has(id))
    .map((id) => {
      const manifest = manifests.get(id);
      const because = [...(requiredBy.get(id) ?? new Set())];

      // The version this step installs. A dependency constraint resolved to a concrete
      // version above pins it; a chain of constraints narrows step by step, so the
      // last one to write wins only after being narrowed against the rest. Without a
      // constraint the manifest's own default applies.
      const requested = versionsRequested.get(id);
      const explicit = userPinned.get(id);
      let pinned = manifest;
      if (explicit) {
        // A version the user typed. Checked against EVERY published version rather than the
        // auto-selectable ones, because `yanked` means "must not be chosen automatically",
        // and a version named by hand is not an automatic choice.
        //
        // It must also be REPORTED when it does not exist. Falling back to latest here meant
        // `utool install my-tool@9.9.9` planned and installed a different version, exited 0,
        // and said nothing - the one outcome a version pin exists to prevent.
        if (manifest.versionNumbers.includes(explicit)) {
          pinned = manifest.at(explicit);
        } else {
          problems.push({
            code: 'E-VERSION-NOT-FOUND',
            message:
              `${id}: no version '${explicit}' is published ` +
              `(available: ${manifest.versionNumbers.join(', ') || 'none'})`,
            toolId: id,
          });
        }
      } else if (requested) {
        const picked = manifest.resolve([requested]);
        // resolve() returning nothing means the pin is unsatisfiable; that was already
        // reported where the constraint was read, so fall back rather than throw here.
        if (picked) pinned = manifest.at(picked.version);
      }

      return {
        manifest: pinned,
        requestedVersion: requested ?? null,
        engines: engines.filter((candidate) => manifest.supports(candidate)),
        installedBecause: because.length > 0 ? because.sort() : ['user'],
        alreadyInstalled: isInstalled ? isInstalled(id) : false,
      };
    });

  return {
    steps,
    problems,
    skipped,
    providerChoices,
    dependencyChoices,
    exitCode: exitCodeFor(problems),
  };
}

/**
 * Satisfy `injects` entries by selecting a provider for each capability, and record
 * why each was pulled in.
 *
 * This is what makes capabilities more than documentation. `dependencies` pins a
 * tool id, so a consumer is welded to one provider; `injects` names a capability, so
 * the registry may choose the provider - and the user can later swap it without
 * editing the consumer. That indirection is the whole point, and it is worthless if
 * nothing ever acts on it.
 *
 * A provider is only chosen when the caller opts in, and only as a last resort:
 * silently pulling in a tool the user did not ask for would be worse than failing
 * with an explanation.
 *
 * @param {object} context
 */
async function resolveInjectedCapabilities(context) {
  const {
    manifests, order, engine, engines,
    fetchManifest, listProviders, providerChoices, problems, requiredBy,
  } = context;

  /** capability -> provider id, for the ones this pass selected */
  const chosenBy = new Map();

  const idOf = (entry) => (typeof entry === 'string' ? entry : entry?.id);

  // Snapshot the order first: the loop below appends to it as it selects providers.
  for (const id of [...order]) {
    const consumer = manifests.get(id);
    if (!consumer) continue;

    for (const capability of consumer.injects) {
      // Someone in the plan already provides it, or we already chose a provider.
      if (chosenBy.has(capability)) continue;
      const alreadyProvided = [...manifests.values()].some((manifest) =>
        manifest.provides.includes(capability),
      );
      if (alreadyProvided) continue;

      const candidates = (await listProviders(capability)).map(idOf).filter(Boolean);
      if (candidates.length === 0) continue; // checkCapabilities reports this

      // Deterministic choice, so the same selection always produces the same plan
      // and therefore the same receipt.
      const sorted = [...new Set(candidates)].sort();
      const pickedId = sorted[0];

      let provider;
      try {
        provider = toManifest(await fetchManifest(pickedId));
      } catch (cause) {
        problems.push({
          code: 'E-CAP-PROVIDER',
          message: `cannot load provider '${pickedId}' for capability '${capability}': ${cause.message}`,
          capability,
        });
        continue;
      }

      if (!engines.some((candidate) => provider.supports(candidate))) {
        problems.push({
          code: 'E-CAP-PROVIDER-ENGINE',
          message:
            `the only provider '${pickedId}' of capability '${capability}' does not support ` +
            `${engines.join(' or ')}`,
          capability,
          provider: pickedId,
        });
        continue;
      }
      if (!satisfiesEngineDeps(provider, engine, manifests, problems)) continue;

      chosenBy.set(capability, pickedId);
      manifests.set(pickedId, provider);
      order.push(pickedId);
      if (!requiredBy.has(pickedId)) requiredBy.set(pickedId, new Set());
      requiredBy.get(pickedId).add(id);

      providerChoices.push({
        capability,
        provider: pickedId,
        neededBy: id,
        alternatives: sorted.slice(1),
      });
    }
  }
}

/**
 * Does a newly selected provider's own dependency set resolve?
 *
 * Cheap check, done here rather than by recursing: a provider chosen for a
 * capability is an addition to a plan already under construction, so a broken
 * dependency in it should be reported as a provider problem rather than silently
 * extending the graph.
 *
 * @returns {boolean} false when a problem was recorded
 */
function satisfiesEngineDeps(provider, engine, manifests, problems) {
  for (const dep of provider.dependenciesFor(engine)) {
    const target = manifests.get(dep.id);
    if (!target) {
      problems.push({
        code: 'E-CAP-PROVIDER-DEP',
        message:
          `provider '${provider.id}' depends on '${dep.id}', which is not in the plan; ` +
          `add it explicitly`,
        toolId: provider.id,
      });
      return false;
    }
    // Multi-version aware: the constraint must be satisfiable by SOME published
    // version, not by the manifest's default specifically.
    let ok = false;
    try {
      ok = Boolean(target.resolve(dep.version ? [dep.version] : []));
    } catch {
      ok = false;
    }
    if (!ok) {
      problems.push({
        code: 'E-DEP-VERSION',
        message:
          `${provider.id} requires ${dep.id} ${dep.version ?? '*'} but the registry publishes ` +
          `${target.versionNumbers.join(', ')}`,
        toolId: provider.id,
      });
      return false;
    }
  }
  return true;
}

/**
 * Pick the version of a dependency that satisfies a constraint, and record it.
 *
 * This is where multi-version support actually bites. A constraint that names an older
 * version must select that version, not the manifest's default; otherwise a consumer
 * asking for `^0.9.0` would silently receive 1.0.0 and the receipt would describe
 * something the consumer never agreed to.
 *
 * @param {Map<string, string>} versionsRequested the plan-wide pin this function narrows;
 *   passed in rather than closed over, because this is a module-level function and closing
 *   over a resolver local is what made it throw `versionsRequested is not defined` at the
 *   first constraint on a multi-version dependency.
 * @returns {import('./manifest.js').ToolVersion|null} the chosen release
 */
function resolveDependencyVersion(
  manifest, dep, dependentId, problems, dependencyChoices, versionsRequested,
) {
  if (!manifest.hasVariants) {
    // One published version: the constraint either admits it or is reported, which is
    // the pre-multi-version behaviour and worth keeping explicit.
    try {
      if (satisfies(manifest.version, dep.version)) return manifest.entry;
    } catch (cause) {
      problems.push({
        code: 'E-DEP-CONSTRAINT',
        message: `${dependentId} declares an invalid constraint for ${dep.id}: ${cause.message}`,
        toolId: dependentId,
      });
      return null;
    }
    problems.push({
      code: 'E-DEP-VERSION',
      message: `${dependentId} requires ${dep.id} ${dep.version} but the registry provides ${manifest.version}`,
      toolId: dependentId,
    });
    return null;
  }

  let chosen;
  try {
    chosen = manifest.resolve(dep.version ? [dep.version] : []);
  } catch (cause) {
    problems.push({
      code: 'E-DEP-CONSTRAINT',
      message: `${dependentId} declares an invalid constraint for ${dep.id}: ${cause.message}`,
      toolId: dependentId,
    });
    return null;
  }

  if (!chosen) {
    problems.push({
      code: 'E-DEP-VERSION',
      message:
        `${dependentId} requires ${dep.id} ${dep.version} but the registry publishes ` +
        `${manifest.versionNumbers.join(', ')}`,
      toolId: dependentId,
    });
    return null;
  }

  // Pin the version this constraint settled on, narrowed against any pin an earlier
  // consumer already set: two consumers constraining the same dependency must agree,
  // and the intersection is what the plan installs.
  const previous = versionsRequested.get(dep.id);
  const constraints = [previous, dep.version].filter(Boolean);
  const narrowed = constraints.length > 0 ? manifest.resolve(constraints) : manifest.resolve([]);
  if (narrowed) versionsRequested.set(dep.id, narrowed.version);

  // Record the choice so the plan can name it, which matters as soon as a tool has
  // more than one version: "the plan says core-editor-utils 0.9.0" is information a
  // user cannot recover from the plan otherwise.
  dependencyChoices.push({
    dependency: dep.id,
    requiredBy: dependentId,
    constraint: dep.version ?? '*',
    chosen: chosen.version,
    alternatives: manifest.versionNumbers.filter((v) => v !== chosen.version),
  });
  return chosen;
}

/** @returns {Promise<ToolManifest|null>} */
async function safeFetch(id, fetchManifest, problems) {
  try {
    const fetched = await fetchManifest(id);
    return fetched instanceof ToolManifest ? fetched : toManifest(fetched);
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
 * Check a tool's declared requirements for one engine.
 *
 * minEngineVersion is the only key the core understands, and it can only *report*
 * it: comparing "2020.3" against a running editor is engine knowledge. So the
 * adapter is asked through `meetsRequirement`, and with no adapter for that engine
 * the floor is reported but not enforced - which is the honest position rather
 * than guessing a comparison.
 */
function checkRequirements(manifest, engine, meetsRequirement, problems) {
  const target = manifest.target(engine);
  if (!target) return;

  const requirements = target.requirements;
  if (requirements.minEngineVersion === undefined) {
    problems.push({
      code: 'E-TARGET-REQUIREMENTS',
      message: `${manifest.id}/${engine}: requirements.minEngineVersion is mandatory`,
      toolId: manifest.id,
    });
    return;
  }

  if (typeof meetsRequirement !== 'function') return;

  for (const [key, value] of Object.entries(requirements)) {
    let ok;
    try {
      ok = meetsRequirement(engine, key, value);
    } catch (cause) {
      problems.push({
        code: 'E-PLATFORM-PARSE',
        message: `${manifest.id}/${engine}: cannot compare ${key} '${value}': ${cause.message}`,
        toolId: manifest.id,
      });
      continue;
    }
    if (ok === false) {
      problems.push({
        code: 'E-PLATFORM',
        message: `${manifest.id}/${engine}: needs ${key} ${value} or newer, but the host does not meet it`,
        toolId: manifest.id,
        engine,
        requirement: key,
        required: value,
      });
    }
  }
}

/**
 * Capability checks: at most one provider per capability, and every inject
 * satisfiable.
 *
 * These are what make `provides`/`injects` worth declaring. Without them a
 * duplicate or missing provider is invisible until something breaks at runtime,
 * inside a consumer's project, far from the registry.
 */
function checkCapabilities(manifests, order, problems, skipped) {
  const skippedIds = new Set(skipped.map((entry) => entry.id));

  /** @type {Map<string, string[]>} */
  const providers = new Map();
  for (const id of order) {
    const manifest = manifests.get(id);
    if (!manifest || skippedIds.has(id)) continue;
    for (const capability of manifest.provides) {
      if (!providers.has(capability)) providers.set(capability, []);
      providers.get(capability).push(id);
    }
  }

  for (const [capability, owners] of providers) {
    if (owners.length > 1) {
      problems.push({
        code: 'E-CAP-CONFLICT',
        message:
          `capability '${capability}' is provided by ${owners.length} tools in this plan ` +
          `(${[...owners].sort().join(', ')}); a consumer of it cannot know which provider it gets`,
        capability,
        providers: [...owners].sort(),
      });
    }
  }

  for (const id of order) {
    const manifest = manifests.get(id);
    if (!manifest || skippedIds.has(id)) continue;
    for (const capability of manifest.injects) {
      if (!providers.has(capability)) {
        problems.push({
          code: 'E-CAP-UNSATISFIED',
          message:
            `${id} injects '${capability}' but nothing in this plan provides it; add the ` +
            `providing tool to the selection`,
          toolId: id,
          capability,
        });
      }
    }
  }
}

/** @returns {number} the CLI exit code implied by a problem list */
export function exitCodeFor(problems) {
  if (problems.length === 0) return 0;
  if (problems.some((problem) => String(problem.code).startsWith('E-PLATFORM'))) return 4;
  return 3;
}

/**
 * Pick the highest version satisfying every constraint.
 *
 * The registry publishes one version per tool today, so nothing calls this yet.
 * It exists so the conflict policy is written down rather than improvised when
 * multi-version manifests arrive.
 *
 * @param {string[]} candidates
 * @param {string[]} constraints
 * @returns {string|null}
 */
export function pickHighestSatisfying(candidates, constraints) {
  const usable = candidates
    .filter((candidate) => constraints.every((constraint) => satisfies(candidate, constraint)))
    .sort(compareVersions);
  return usable.length > 0 ? usable[usable.length - 1] : null;
}

export { PlatformError, ResolutionError };
