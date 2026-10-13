/**
 * Typed view over a validated tool manifest (formatVersion 3).
 *
 * Mirrors the format's own split: engine- and version-neutral accessors at the top,
 * and one published release behind `entry`, whose `targets` map holds the
 * engine-specific data. Nothing here knows what a Unity or a Godot is.
 *
 * The central idea is that a manifest is a LIST of releases, not a release. Every
 * accessor that reads engine data therefore has to know which version is being read,
 * which is why an instance carries that choice and why `at(version)` exists.
 */

import path from 'node:path';

import {
  ARTIFACT_PATH_PARTS_PATTERN,
  ARTIFACT_TYPE,
  UNPACK,
  expectedArtifactName,
} from './format.js';
import { compareVersions, satisfies } from './semver.js';

/**
 * One engine's view of ONE version of a tool.
 */
export class ToolTarget {
  /**
   * @param {string} engine
   * @param {object} target the raw `versions[n].targets.<engine>` mapping
   * @param {string} toolId
   * @param {string} version
   * @param {boolean} multiEngine
   */
  constructor(engine, target, toolId, version, multiEngine) {
    this.engine = engine;
    this.doc = target;
    this.toolId = toolId;
    this.version = version;
    this.multiEngine = multiEngine;
  }

  /** Adapter-defined floors. minEngineVersion is guaranteed to exist. */
  get requirements() {
    return this.doc.requirements ?? {};
  }

  get minEngineVersion() {
    return String(this.requirements.minEngineVersion);
  }

  /** Everything except minEngineVersion, for adapters with extra floors. */
  get extraRequirements() {
    const { minEngineVersion, ...rest } = this.requirements;
    return rest;
  }

  get artifact() {
    return this.doc.artifact ?? {};
  }

  get type() {
    return this.artifact.type;
  }

  get format() {
    return this.artifact.format;
  }

  get isExternal() {
    return this.type === ARTIFACT_TYPE.EXTERNAL;
  }

  get shouldUnpack() {
    if (this.isExternal) return false;
    if (this.type === ARTIFACT_TYPE.FILE) return false;
    return this.artifact.unpack !== UNPACK.NONE;
  }

  get artifactPath() {
    return this.artifact.path ?? null;
  }

  get contentRoot() {
    return this.artifact.contentRoot ?? null;
  }

  get targetPath() {
    return this.artifact.targetPath ?? null;
  }

  get subdirectory() {
    return this.artifact.subdirectory ?? null;
  }

  get editorOnly() {
    return this.artifact.editorOnly === true;
  }

  get restartRequired() {
    return this.artifact.restartRequired === true;
  }

  get files() {
    return this.artifact.files ?? [];
  }

  get external() {
    if (!this.isExternal) return null;
    return {
      source: this.artifact.source ?? null,
      url: this.artifact.url ?? null,
      ref: this.artifact.ref ?? null,
      subdirectory: this.artifact.subdirectory ?? null,
      upmPackageName: this.artifact.upmPackageName ?? null,
    };
  }

  /** The declared artifact, in the shape verification expects. */
  get declaredArtifact() {
    if (this.isExternal) return null;
    return {
      type: this.type,
      format: this.format,
      path: this.artifactPath,
      size: this.artifact.size,
      sha256: this.artifact.sha256,
      unpack: this.artifact.unpack,
      targetPath: this.targetPath,
      contentRoot: this.contentRoot,
      subdirectory: this.subdirectory,
      files: this.files,
      editorOnly: this.editorOnly,
    };
  }

  /**
   * @returns {{ok: boolean, reason?: string}}
   */
  checkArtifactConvention() {
    if (this.isExternal) return { ok: true };

    const declared = this.artifactPath;
    if (typeof declared !== 'string') {
      return { ok: false, reason: 'artifact.path is missing' };
    }
    const match = ARTIFACT_PATH_PARTS_PATTERN.exec(declared);
    if (!match) {
      return {
        ok: false,
        reason: `artifact path must be payloads/<id>/artifacts/<file>, got ${declared}`,
      };
    }
    const [, directoryId, fileName] = match;
    if (directoryId !== this.toolId) {
      return {
        ok: false,
        reason: `artifact directory '${directoryId}' does not match the tool id '${this.toolId}'`,
      };
    }
    const expected = expectedArtifactName(
      this.toolId, this.version, this.engine, this.multiEngine, String(this.format),
    );
    if (fileName !== expected) {
      return { ok: false, reason: `artifact must be named '${expected}', got '${fileName}'` };
    }
    return { ok: true };
  }

  toSummary() {
    return {
      engine: this.engine,
      requirements: this.requirements,
      artifactType: this.type,
      artifactFormat: this.format ?? null,
      artifactPath: this.artifactPath,
      artifactSize: this.artifact.size ?? null,
      contentRoot: this.contentRoot,
      editorOnly: this.editorOnly,
      external: this.external,
      files: this.files,
    };
  }
}

/**
 * One published release.
 */
export class ToolVersion {
  /**
   * @param {object} entry the raw `versions[n]` mapping
   * @param {string} toolId
   */
  constructor(entry, toolId) {
    this.doc = entry;
    this.toolId = toolId;
  }

  get version() {
    return String(this.doc.version);
  }

  get targets() {
    return this.doc.targets ?? {};
  }

  get engines() {
    return Object.keys(this.targets).sort();
  }

  get deprecated() {
    return this.doc.deprecated === true;
  }

  /**
   * Withdrawn: must not be chosen automatically, for a release that is broken or
   * unsafe. Distinct from `deprecated`, which only means "prefer something newer".
   */
  get yanked() {
    return this.doc.yanked === true;
  }

  get releasedAt() {
    return this.doc.releasedAt ?? null;
  }

  get notes() {
    return this.doc.notes ?? null;
  }

  /** @returns {ToolTarget|null} */
  target(engine) {
    const raw = this.targets[engine];
    if (!raw) return null;
    return new ToolTarget(engine, raw, this.toolId, this.version, this.engines.length > 1);
  }

  get allTargets() {
    return this.engines.map((engine) => this.target(engine));
  }

  supports(engine) {
    return Object.prototype.hasOwnProperty.call(this.targets, engine);
  }
}

export class ToolManifest {
  /**
   * @param {Record<string, any>|ToolManifest} doc a loaded manifest, or an existing
   *   ToolManifest. Accepting a manifest makes this idempotent, which matters because
   *   callers at different layers each normalise what they receive.
   * @param {{version?: string}} [options] pin the version this instance reads;
   *   defaults to `latest`
   */
  constructor(doc, options = {}) {
    const fromManifest = doc instanceof ToolManifest;
    /** @type {Record<string, any>} */
    this.doc = fromManifest ? doc.doc : doc;
    this.requestedVersion = options.version
      ? String(options.version)
      : (fromManifest ? doc.requestedVersion : null);
    this.entries = Array.isArray(this.doc.versions) ? this.doc.versions : [];
  }

  // --- engine- and version-neutral ------------------------------------

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

  get license() {
    return this.doc.license ?? null;
  }

  get author() {
    return this.doc.author ?? null;
  }

  get homepage() {
    return this.doc.homepage ?? null;
  }

  get tags() {
    return this.doc.tags ?? [];
  }

  get deprecated() {
    return this.doc.deprecated === true;
  }

  get provides() {
    return this.doc.provides ?? [];
  }

  get injects() {
    return this.doc.injects ?? [];
  }

  get dependencies() {
    return this.doc.dependencies ?? [];
  }

  get requiredDependencies() {
    return this.dependencies.filter((dep) => !dep.optional);
  }

  /**
   * Dependencies that apply to a given engine. A dependency with no `engines` list
   * applies everywhere.
   *
   * @param {string|null} engine
   */
  dependenciesFor(engine) {
    if (!engine) return this.dependencies;
    return this.dependencies.filter(
      (dep) => !dep.engines || dep.engines.length === 0 || dep.engines.includes(engine),
    );
  }

  get dependencyIds() {
    return this.dependencies.map((dep) => dep.id);
  }

  // --- versions -------------------------------------------------------

  /** The version an importer offers by default. */
  get latest() {
    return String(this.doc.latest);
  }

  get versions() {
    // Note: no dependency on isCrossEngine here. ToolVersion derives that from its own
    // target count, and asking the manifest would be circular (versions -> entry ->
    // isCrossEngine -> entry -> versions).
    return this.entries.map((entry) => new ToolVersion(entry, this.id));
  }

  get versionNumbers() {
    return this.versions.map((entry) => entry.version);
  }

  /**
   * The version this instance reads: the pinned one, else `latest`.
   *
   * A pin naming a version that is not published falls back to `latest` rather than
   * resolving to nothing, so a stale pin degrades instead of emptying a whole listing.
   */
  get version() {
    if (this.requestedVersion && this.versionNumbers.includes(this.requestedVersion)) {
      return this.requestedVersion;
    }
    return this.latest;
  }

  /** @returns {ToolVersion|null} the release being read */
  get entry() {
    return this.versions.find((candidate) => candidate.version === this.version) ?? null;
  }

  /**
   * Which releases could be installed automatically?
   *
   * Yanked ones are excluded, because "withdrawn" means precisely that it must not be
   * chosen without a human saying so.
   */
  selectable() {
    return this.versions.filter((entry) => !entry.yanked);
  }

  /**
   * The highest release satisfying every constraint.
   *
   * @param {string[]} constraints
   * @param {{allowYanked?: boolean}} [options] allowYanked lets an explicit pin reach a
   *   withdrawn version, which a receipt may already reference.
   * @returns {ToolVersion|null}
   */
  resolve(constraints = [], options = {}) {
    const pool = options.allowYanked ? this.versions : this.selectable();
    const usable = pool.filter((entry) =>
      constraints.every((constraint) => {
        try {
          return satisfies(entry.version, constraint);
        } catch {
          return false;
        }
      }),
    );
    if (usable.length === 0) return null;
    usable.sort((a, b) => compareVersions(a.version, b.version));
    return usable[usable.length - 1];
  }

  /** @returns {ToolVersion|null} the newest release that is not deprecated */
  get preferred() {
    const fresh = this.selectable().filter((entry) => !entry.deprecated);
    const pool = fresh.length > 0 ? fresh : this.selectable();
    if (pool.length === 0) return null;
    return [...pool].sort((a, b) => compareVersions(b.version, a.version))[0];
  }

  /** @returns {boolean} more than one release is published */
  get hasVariants() {
    return this.versions.length > 1;
  }

  // --- engine-specific, for the version being read --------------------

  get targets() {
    return this.entry?.targets ?? {};
  }

  /** Engine names on the version being read, sorted. */
  get engines() {
    return this.entry?.engines ?? [];
  }

  /** Engines across ALL versions, for "does this tool ever support X". */
  get allEngines() {
    const found = new Set();
    for (const entry of this.versions) {
      for (const engine of entry.engines) found.add(engine);
    }
    return [...found].sort();
  }

  get isCrossEngine() {
    return this.engines.length > 1;
  }

  /** @returns {ToolTarget|null} null when this version has no such target */
  target(engine) {
    return this.entry?.target(engine) ?? null;
  }

  get allTargets() {
    return this.entry?.allTargets ?? [];
  }

  supports(engine) {
    return this.entry?.supports(engine) ?? false;
  }

  /** A copy reading another published version, so one manifest can be compared across releases. */
  at(version) {
    return new ToolManifest(this.doc, { version });
  }

  /**
   * Serializable summary for index.yaml.
   *
   * Carries every version NUMBER plus `latest`, so a listing can offer a choice. It
   * deliberately omits per-version engines, floors and artifacts, which belong to the
   * manifest.
   */
  toSummary(manifestPath) {
    return {
      id: this.id,
      displayName: this.displayName,
      type: this.type,
      description: this.description,
      latest: this.latest,
      versions: this.versionNumbers,
      engines: this.allEngines,
      provides: this.provides,
      injects: this.injects,
      dependencies: this.dependencies,
      tags: this.tags,
      manifestPath: manifestPath ?? `payloads/${this.id}/tool.yaml`,
    };
  }

  /** Absolute path of one engine's artifact for the version being read. */
  artifactAbsolutePath(registryRoot, engine) {
    const target = this.target(engine);
    return target?.artifactPath ? path.join(registryRoot, target.artifactPath) : null;
  }
}

/** @param {Record<string, any>|ToolManifest} doc @param {{version?: string}} [options] */
export function toManifest(doc, options = {}) {
  return doc instanceof ToolManifest && !options.version ? doc : new ToolManifest(doc, options);
}
