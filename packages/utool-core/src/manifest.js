/**
 * Typed view over a validated tool.utool document.
 *
 * The loader guarantees a mapping with a known kind and formatVersion; this
 * class guarantees the fields the resolver and installer rely on, and centralises
 * the few derived values (artifact file name, install ordering keys) so they are
 * computed in exactly one place.
 */

import path from 'node:path';

import { ARTIFACT_PATH_PARTS_PATTERN, SOURCE_KIND, SOURCE_TYPE } from './format.js';

export class ToolManifest {
  /**
   * @param {Record<string, any>|ToolManifest} doc a loaded .utool document, or an
   *   existing ToolManifest. Accepting a manifest makes this constructor
   *   idempotent, which matters because callers at different layers (source,
   *   resolver, CLI) each normalise what they receive.
   */
  constructor(doc) {
    /** @type {Record<string, any>} */
    this.doc = doc instanceof ToolManifest ? doc.doc : doc;
  }

  get id() {
    return this.doc.id;
  }

  get displayName() {
    return this.doc.displayName;
  }

  get type() {
    return this.doc.type;
  }

  get description() {
    return this.doc.description;
  }

  get version() {
    return String(this.doc.version);
  }

  get minUnityVersion() {
    return String(this.doc.minUnityVersion);
  }

  get minDotNetVersion() {
    return String(this.doc.minDotNetVersion);
  }

  get tags() {
    return this.doc.tags ?? [];
  }

  /** @returns {{id: string, version?: string, reason?: string, optional?: boolean}[]} */
  get dependencies() {
    return this.doc.dependencies ?? [];
  }

  /** Required dependencies only: the ones that must be pulled in transitively. */
  get requiredDependencies() {
    return this.dependencies.filter((dep) => !dep.optional);
  }

  get source() {
    return this.doc.source ?? {};
  }

  get sourceKind() {
    return this.source.kind;
  }

  get isBundled() {
    return this.sourceKind === SOURCE_KIND.BUNDLED;
  }

  get isExternal() {
    return this.sourceKind === SOURCE_KIND.EXTERNAL;
  }

  get isGit() {
    return this.source.type === SOURCE_TYPE.GIT;
  }

  get artifactPath() {
    return this.source.artifactPath;
  }

  get artifactFormat() {
    return this.source.artifactFormat;
  }

  /** @returns {{path: string, format: string, size: number, sha256: string}|null} */
  get artifact() {
    const list = this.doc.artifacts;
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[0];
  }

  get contentRoot() {
    return this.doc.install?.contentRoot;
  }

  get editorOnly() {
    return this.doc.install?.editorOnly === true;
  }

  get restartRequired() {
    return this.doc.install?.restartRequired === true;
  }

  get files() {
    return this.doc.files ?? [];
  }

  get deprecated() {
    return this.doc.deprecated === true;
  }

  /** Declared dependency ids, for graph work. */
  get dependencyIds() {
    return this.dependencies.map((dep) => dep.id);
  }

  /** The upstream git coordinates, or null when the tool is bundled. */
  get git() {
    if (!this.isGit) return null;
    const { url, ref, subdirectory, upmPackageName } = this.source;
    return { url, ref, subdirectory: subdirectory ?? null, upmPackageName: upmPackageName ?? null };
  }

  /**
   * Absolute path of the artifact inside a registry root.
   *
   * @param {string} registryRoot
   */
  artifactAbsolutePath(registryRoot) {
    return path.join(registryRoot, this.artifactPath);
  }

  /**
   * Does this artifact path follow the mandated convention
   * payloads/<id>/artifacts/<id>-<version>.<ext> ?
   *
   * @returns {{ok: boolean, reason?: string}}
   */
  checkArtifactPathConvention() {
    const declared = this.artifactPath;
    if (typeof declared !== 'string') {
      return { ok: false, reason: 'source.artifactPath is missing' };
    }
    const match = ARTIFACT_PATH_PARTS_PATTERN.exec(declared);
    if (!match) {
      return {
        ok: false,
        reason: `must match payloads/<id>/artifacts/<id>-<version>.<ext>, got ${declared}`,
      };
    }
    const [, dirId, fileName] = match;
    if (dirId !== this.id) {
      return { ok: false, reason: `artifact directory '${dirId}' does not match id '${this.id}'` };
    }
    const expected = `${this.id}-${this.version}.${this.artifactFormat}`;
    if (fileName !== expected) {
      return { ok: false, reason: `artifact must be named '${expected}', got '${fileName}'` };
    }
    return { ok: true };
  }

  /** Serializable summary, exactly the shape index.utool carries. */
  toSummary(manifestPath) {
    return {
      id: this.id,
      displayName: this.displayName,
      type: this.type,
      description: this.description,
      version: this.version,
      sourceKind: this.sourceKind,
      minUnityVersion: this.minUnityVersion,
      minDotNetVersion: this.minDotNetVersion,
      tags: this.tags,
      dependencies: this.dependencies,
      manifestPath: manifestPath ?? `payloads/${this.id}/tool.utool`,
      artifactPath: this.artifactPath ?? null,
      artifactFormat: this.artifactFormat ?? null,
    };
  }
}

/** @param {Record<string, any>} doc */
export function toManifest(doc) {
  return new ToolManifest(doc);
}
