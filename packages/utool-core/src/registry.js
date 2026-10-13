/**
 * Registry validation.
 *
 * The same rules tools/validate_registry.py enforces, expressed here because the
 * import tool must be able to check a registry it fetched over HTTP without
 * running Python. The two implementations are kept deliberately parallel: when a
 * rule changes, both change.
 *
 * Every violation is collected rather than thrown, so one run reports the whole
 * picture.
 *
 * Containers arrive through a registry rather than being known here, so validating
 * a Unity payload requires the Unity adapter to have been loaded. That is why the
 * signature takes `containers` explicitly: a caller that forgets to load an adapter
 * gets a clear "no handler registered" instead of a silent pass.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DiagnosticBag } from './errors.js';
import {
  ALLOWED_PAYLOAD_ENTRIES,
  ARTIFACT_TYPE,
  CORE_ARCHIVE_FORMATS,
  FILE_NAMES,
  FORMAT_VERSION,
  ID_PATTERN,
  KIND,
  UNPACK,
  isCapability,
} from './format.js';
import { checkHeader, loadUtool } from './loader.js';
import { toManifest } from './manifest.js';
import { verifyArtifactFile } from './artifacts.js';
import { satisfies } from './semver.js';

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {{code: string, message: string}[]} errors
 * @property {{code: string, message: string}[]} warnings
 * @property {number} checks
 * @property {import('./manifest.js').ToolManifest[]} manifests
 */

/**
 * Validate a whole registry rooted at a local directory.
 *
 * @param {string} root
 * @param {{
 *   containers: import('./containers.js').ContainerRegistry,
 *   hash?: boolean,
 *   quiet?: boolean,
 *   onCheck?: (message: string) => void,
 * }} options
 * @returns {Promise<ValidationResult>}
 */
export async function validateRegistry(root, options) {
  const { containers, hash = true, onCheck } = options;
  if (!containers) {
    throw new TypeError(
      'validateRegistry requires a container registry; build one with createCoreContainerRegistry() ' +
        "and register the adapters for the engines you expect (for Unity: unityAdapter.containerHandlers)",
    );
  }

  const bag = new DiagnosticBag();
  const note = (message) => {
    bag.note();
    onCheck?.(message);
  };

  const payloadsRoot = path.join(root, 'payloads');
  if (!existsSync(payloadsRoot)) {
    bag.error('E-LAYOUT', `missing payloads/ directory under ${root}`);
    return result(bag, []);
  }

  const entries = (await readdir(payloadsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  /** @type {import('./manifest.js').ToolManifest[]} */
  const manifests = [];

  for (const id of entries) {
    const dir = path.join(payloadsRoot, id);
    const manifestPath = path.join(dir, FILE_NAMES.MANIFEST);

    if (!existsSync(manifestPath)) {
      bag.error(
        'E-MANIFEST-MISSING',
        `${id}: no ${FILE_NAMES.MANIFEST} (every payload must declare its metadata)`,
      );
      continue;
    }

    let doc;
    try {
      doc = loadUtool(manifestPath);
      checkHeader(doc, manifestPath, KIND.TOOL);
    } catch (cause) {
      bag.error(cause.code ?? 'E-MANIFEST', `${id}/${FILE_NAMES.MANIFEST}: ${cause.message}`);
      continue;
    }

    const manifest = toManifest(doc);

    // --- identity -------------------------------------------------------
    if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
      bag.error('E-ID-FORMAT', `${id}: id ${JSON.stringify(manifest.id)} is not lowercase kebab-case`);
    } else if (manifest.id !== id) {
      bag.error('E-ID-DIR', `${id}: directory name must equal the id '${manifest.id}'`);
    }

    // --- capabilities ---------------------------------------------------
    for (const [field, list] of [['provides', manifest.provides], ['injects', manifest.injects]]) {
      for (const capability of list) {
        if (!isCapability(capability)) {
          bag.error(
            'E-CAP-FORMAT',
            `${id}: ${field} entry ${JSON.stringify(capability)} needs at least two dot-separated ` +
              `lowercase segments, so it states its namespace`,
          );
        }
      }
    }

    const stray = (await readdir(dir)).filter((name) => !ALLOWED_PAYLOAD_ENTRIES.includes(name));
    if (stray.length > 0) {
      bag.error(
        'E-PAYLOAD-EXTRA',
        `${id}: only ${FILE_NAMES.MANIFEST}, README.md and artifacts/ may live in a payload ` +
          `(found ${stray.sort().join(', ')}) - loose files are never importable`,
      );
    }

    // --- targets --------------------------------------------------------
    if (manifest.engines.length === 0) {
      bag.error('E-TARGETS-MISSING', `${id}: targets must declare at least one engine`);
    }

    const declaredNames = new Set();
    for (const engine of manifest.engines) {
      const target = manifest.target(engine);

      if (target.minEngineVersion === undefined || target.minEngineVersion === 'undefined') {
        bag.error(
          'E-TARGET-REQUIREMENTS',
          `${id}/${engine}: requirements.minEngineVersion is mandatory; a tool that cannot state its ` +
            `floor is not admitted`,
        );
      }

      if (target.isExternal) {
        const external = target.external;
        if (!external?.url || !external?.ref) {
          bag.error('E-EXTERNAL-INCOMPLETE', `${id}/${engine}: external source needs both url and ref`);
        } else {
          note(`${id}/${engine}: external ${external.source} ${external.url} @ ${external.ref}`);
        }
        continue;
      }

      if (!ARTIFACT_TYPE[String(target.type).toUpperCase()] && target.type !== 'file') {
        bag.error(
          'E-ARTIFACT-TYPE',
          `${id}/${engine}: unknown artifact type ${JSON.stringify(target.type)}`,
        );
        continue;
      }

      if (target.artifactPath) declaredNames.add(path.basename(target.artifactPath));

      const convention = target.checkArtifactConvention();
      if (!convention.ok) {
        bag.error('E-ARTIFACT-NAME', `${id}/${engine}: ${convention.reason}`);
      }

      // A core archive must name a core format; an engine container needs a handler.
      if (target.type === ARTIFACT_TYPE.ARCHIVE && !CORE_ARCHIVE_FORMATS.includes(String(target.format))) {
        bag.error(
          'E-ARTIFACT-FORMAT',
          `${id}/${engine}: format '${target.format}' is not a core archive format ` +
            `(${CORE_ARCHIVE_FORMATS.join(', ')}); an engine-specific container must be declared ` +
            `as type package`,
        );
      }

      if (!target.artifactPath) {
        bag.error('E-ARTIFACT-MISSING', `${id}/${engine}: artifact.path is required`);
        continue;
      }

      const artifactFile = path.join(root, target.artifactPath);
      if (!existsSync(artifactFile)) {
        bag.error('E-ARTIFACT-MISSING', `${id}/${engine}: declared artifact ${target.artifactPath} does not exist`);
        continue;
      }

      if (!hash) {
        note(`${id}/${engine}: hash verification skipped by request`);
        continue;
      }

      try {
        const report = await verifyArtifactFile(artifactFile, target.declaredArtifact, containers);
        note(
          `${id}/${engine}: ${report.format ?? 'file'}, ${report.size} bytes, sha256 verified, ` +
            `${report.items.length} destination(s)`,
        );
      } catch (cause) {
        bag.error(cause.code ?? 'E-ARTIFACT', `${id}/${engine}: ${cause.message}`);
      }
    }

    const artifactsDir = path.join(dir, 'artifacts');
    if (existsSync(artifactsDir)) {
      const undeclared = (await readdir(artifactsDir)).filter((name) => !declaredNames.has(name));
      if (undeclared.length > 0) {
        bag.error(
          'E-ARTIFACT-STRAY',
          `${id}: artifacts/ holds undeclared file(s): ${undeclared.sort().join(', ')}`,
        );
      }
    }

    manifests.push(manifest);
  }

  // --- dependencies -----------------------------------------------------
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  note(`${byId.size} manifest(s), checking dependencies and capabilities`);

  for (const manifest of manifests) {
    for (const dep of manifest.dependencies) {
      if (dep.id === manifest.id) {
        bag.error('E-DEP-SELF', `${manifest.id}: depends on itself`);
        continue;
      }
      const target = byId.get(dep.id);
      if (!target) {
        bag.error('E-DEP-MISSING', `${manifest.id}: depends on unknown tool '${dep.id}'`);
        continue;
      }
      try {
        if (satisfies(target.version, dep.version)) {
          note(`${manifest.id} -> ${dep.id} ${dep.version ?? '*'} satisfied by ${target.version}`);
        } else {
          bag.error(
            'E-DEP-VERSION',
            `${manifest.id}: requires ${dep.id} ${dep.version} but the registry provides ${target.version}`,
          );
        }
      } catch (cause) {
        bag.error('E-DEP-CONSTRAINT', `${manifest.id}: invalid constraint for ${dep.id}: ${cause.message}`);
      }
    }
  }

  // --- capabilities: one provider each, every inject satisfiable --------
  /** @type {Map<string, string[]>} */
  const providers = new Map();
  for (const manifest of manifests) {
    for (const capability of manifest.provides) {
      if (!providers.has(capability)) providers.set(capability, []);
      providers.get(capability).push(manifest.id);
    }
  }
  // Multiple providers in the REGISTRY are legitimate alternatives: injects names
  // a capability precisely so a user may choose among them. The real conflict is
  // inside one PLAN, which the resolver refuses, because two providers installed into
  // one project is what leaves a consumer unable to say which it received.
  for (const [capability, owners] of providers) {
    if (owners.length > 1) {
      bag.warn(
        'W-CAP-MULTIPLE',
        `capability '${capability}' has ${owners.length} providers ` +
          `(${[...owners].sort().join(', ')}); installing more than one of them at once will be ` +
          `refused, because a consumer cannot tell which provider it got`,
      );
    }
  }
  for (const manifest of manifests) {
    for (const capability of manifest.injects) {
      if (!providers.has(capability)) {
        bag.error(
          'E-CAP-UNSATISFIED',
          `${manifest.id}: injects '${capability}' but no tool in the registry provides it`,
        );
      } else {
        note(`${manifest.id} injects '${capability}' satisfied by ${providers.get(capability).join(', ')}`);
      }
    }
  }

  // Cycle detection over required dependencies.
  const graph = new Map(
    manifests.map((manifest) => [
      manifest.id,
      manifest.requiredDependencies.map((dep) => dep.id).filter((id) => byId.has(id)),
    ]),
  );
  const state = new Map(); // 1 = on stack, 2 = done
  const reportedCycles = new Set();

  const visit = (node, stack) => {
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [...stack, node, next].join(' -> ');
        if (!reportedCycles.has(cycle)) {
          reportedCycles.add(cycle);
          bag.error('E-DEP-CYCLE', `dependency cycle: ${cycle}`);
        }
      } else if (!state.has(next)) {
        visit(next, [...stack, node]);
      }
    }
    state.set(node, 2);
  };

  for (const id of graph.keys()) {
    if (!state.has(id)) visit(id, []);
  }

  // --- index ------------------------------------------------------------
  const indexPath = path.join(root, FILE_NAMES.INDEX);
  if (!existsSync(indexPath)) {
    bag.error('E-INDEX-MISSING', `${FILE_NAMES.INDEX} is missing (run with --write-index)`);
  } else {
    try {
      const indexDoc = loadUtool(indexPath);
      checkHeader(indexDoc, indexPath, KIND.INDEX);
      const expected = buildIndex(manifests, indexDoc.repository ?? null);
      const actualTools = indexDoc.tools ?? [];
      if (JSON.stringify(actualTools) !== JSON.stringify(expected.tools)) {
        const actualIds = new Set(actualTools.map((tool) => tool.id));
        const expectedIds = new Set(expected.tools.map((tool) => tool.id));
        const missing = [...expectedIds].filter((id) => !actualIds.has(id)).sort();
        const stale = [...actualIds].filter((id) => !expectedIds.has(id)).sort();
        const detail = [];
        if (missing.length) detail.push(`missing: ${missing.join(', ')}`);
        if (stale.length) detail.push(`stale: ${stale.join(', ')}`);
        if (detail.length === 0) detail.push('entries differ in content');
        bag.error('E-INDEX-STALE', `${FILE_NAMES.INDEX} is out of date (${detail.join('; ')})`);
      } else {
        note(`${FILE_NAMES.INDEX} matches ${expected.tools.length} tool(s)`);
      }
    } catch (cause) {
      bag.error(cause.code ?? 'E-INDEX', `${FILE_NAMES.INDEX}: ${cause.message}`);
    }
  }

  return result(bag, manifests);
}

/**
 * Build the index document from manifests. Mirrors the Python implementation so
 * either side can regenerate the file the other one checks.
 *
 * @param {import('./manifest.js').ToolManifest[]} manifests
 * @param {string|null} repository
 */
export function buildIndex(manifests, repository = null) {
  const tools = [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((manifest) => manifest.toSummary());
  return {
    kind: KIND.INDEX,
    formatVersion: FORMAT_VERSION,
    repository,
    tools,
  };
}

function result(bag, manifests) {
  return {
    ok: bag.ok,
    errors: bag.errors,
    warnings: bag.warnings,
    checks: bag.checks,
    manifests,
  };
}

export { UNPACK };
