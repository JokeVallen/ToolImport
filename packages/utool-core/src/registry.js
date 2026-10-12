/**
 * Registry validation.
 *
 * The same rules tools/validate_registry.py enforces, expressed here because the
 * import tool must be able to check a registry it fetched over HTTP without
 * running Python. The two implementations are kept deliberately parallel; when a
 * rule changes, both change.
 *
 * Every violation is collected rather than thrown, so one run reports the whole
 * picture.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DiagnosticBag } from './errors.js';
import {
  ALLOWED_PAYLOAD_ENTRIES,
  ID_PATTERN,
  FILE_NAMES,
  KIND,
  FORMAT_VERSION,
} from './format.js';
import { loadUtool, checkHeader } from './loader.js';
import { toManifest } from './manifest.js';
import { verifyArtifactFile, verifyArtifactBytes } from './artifacts.js';
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
 * @param {{hash?: boolean, quiet?: boolean, onCheck?: (message: string) => void}} [options]
 * @returns {Promise<ValidationResult>}
 */
export async function validateRegistry(root, options = {}) {
  const { hash = true, onCheck } = options;
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

    const stray = (await readdir(dir)).filter((name) => !ALLOWED_PAYLOAD_ENTRIES.includes(name));
    if (stray.length > 0) {
      bag.error(
        'E-PAYLOAD-EXTRA',
        `${id}: only ${FILE_NAMES.MANIFEST}, README.md and artifacts/ may live in a payload ` +
          `(found ${stray.sort().join(', ')}) - loose files are never importable`,
      );
    }

    // --- packaging ------------------------------------------------------
    if (manifest.isBundled) {
      const convention = manifest.checkArtifactPathConvention();
      if (!convention.ok) {
        bag.error('E-ARTIFACT-PATH', `${id}: ${convention.reason}`);
      }

      const declared = manifest.artifact;
      if (!declared) {
        bag.error('E-ARTIFACT-MISSING', `${id}: source.kind is bundled but artifacts is empty`);
      } else {
        const artifactFile = path.join(root, declared.path);
        if (!existsSync(artifactFile)) {
          bag.error('E-ARTIFACT-MISSING', `${id}: declared artifact ${declared.path} does not exist`);
        } else {
          try {
            const report = await verifyArtifactFile(artifactFile, declared);
            note(`${id}: ${report.format}, ${report.size} bytes, sha256 verified, ${report.entries} entries`);
          } catch (cause) {
            bag.error(cause.code ?? 'E-ARTIFACT', `${id}: ${cause.message}`);
          }
        }

        const artifactsDir = path.join(dir, 'artifacts');
        if (existsSync(artifactsDir)) {
          const declaredName = path.basename(declared.path);
          const undeclared = (await readdir(artifactsDir)).filter((name) => name !== declaredName);
          if (undeclared.length > 0) {
            bag.error(
              'E-ARTIFACT-STRAY',
              `${id}: artifacts/ holds undeclared file(s): ${undeclared.sort().join(', ')}`,
            );
          }
        }
      }
    } else if (manifest.isExternal) {
      const git = manifest.git;
      if (!git || !git.url || !git.ref) {
        bag.error('E-EXTERNAL-INCOMPLETE', `${id}: external source needs both url and ref`);
      } else {
        note(`${id}: external ${manifest.source.type} ${git.url} @ ${git.ref}`);
      }
      if (Array.isArray(doc.artifacts) && doc.artifacts.length > 0) {
        bag.error('E-EXTERNAL-ARTIFACT', `${id}: an external source must not declare artifacts`);
      }
    }

    if (hash === false) {
      // Only reachable through the explicit --no-hash flag.
      note(`${id}: hash verification skipped by request`);
    }

    manifests.push(manifest);
  }

  // --- dependencies -----------------------------------------------------
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  note(`${byId.size} manifest(s), checking dependencies`);

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

  // Cycle detection over required dependencies only.
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

export { verifyArtifactBytes };
