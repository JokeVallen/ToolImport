/**
 * Typed view over a validated tool.utool document (formatVersion 2).
 *
 * The class mirrors the format's own split: engine-neutral accessors at the top,
 * and everything engine-specific behind `target(engine)`. Nothing here knows what
 * a Unity or a Godot is - a target is addressed by name and its requirement keys
 * are read as plain data.
 */

import path from 'node:path';

import {
  ARTIFACT_PATH_PARTS_PATTERN,
  ARTIFACT_TYPE,
  UNPACK,
  expectedArtifactName,
} from './format.js';

/**
 * One engine's view of a tool.
 */
export class ToolTarget {
  /**
   * @param {string} engine
   * @param {object} target the raw `targets.<engine>` mapping
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

  /** The engine version floor, which every adapter must be able to compare. */
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

  /** True when the artifact must be unpacked rather than used as-is. */
  get shouldUnpack() {
    if (this.isExternal) return false;
    if (this.type === ARTIFACT_TYPE.FILE) return false;
    return this.artifact.unpack !== UNPACK.NONE;
  }

  /** Repository-relative artifact path, or null when nothing is stored here. */
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

  /** Upstream coordinates, when this target stores no artifact. */
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
   * Does the artifact path and file name follow the mandated convention?
   *
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

  /** Serializable per-engine summary for the CLI. */
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

export class ToolManifest {
  /**
   * @param {Record<string, any>|ToolManifest} doc a loaded .utool document, or an
   *   existing ToolManifest. Accepting a manifest makes this constructor
   *   idempotent, which matters because callers at different layers each normalise
   *   what they receive.
   */
  constructor(doc) {
    /** @type {Record<string, any>} */
    this.doc = doc instanceof ToolManifest ? doc.doc : doc;
  }

  // --- engine-neutral -------------------------------------------------

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

  /**
   * Capabilities this tool offers. A consumer that injects one of these does not
   * care which tool provides it, which is what makes a provider replaceable
   * without editing its consumers.
   */
  get provides() {
    return this.doc.provides ?? [];
  }

  /** Capabilities this tool needs from somewhere else in the plan. */
  get injects() {
    return this.doc.injects ?? [];
  }

  /** @returns {{id: string, version?: string, reason?: string, optional?: boolean, engines?: string[]}[]} */
  get dependencies() {
    return this.doc.dependencies ?? [];
  }

  /** Required dependencies: the ones that must be pulled in transitively. */
  get requiredDependencies() {
    return this.dependencies.filter((dep) => !dep.optional);
  }

  /**
   * Dependencies that apply to a given engine. A dependency with no `engines` list
   * applies everywhere; otherwise it counts only for the named engines.
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

  // --- engine-specific ------------------------------------------------

  /** @returns {Record<string, object>} engine name -> raw target mapping */
  get targets() {
    return this.doc.targets ?? {};
  }

  /** @returns {string[]} engine names this tool declares, sorted */
  get engines() {
    return Object.keys(this.targets).sort();
  }

  /** @returns {boolean} true when more than one engine is declared */
  get isCrossEngine() {
    return this.engines.length > 1;
  }

  /**
   * @param {string} engine
   * @returns {ToolTarget|null}
   */
  target(engine) {
    const raw = this.targets[engine];
    if (!raw) return null;
    return new ToolTarget(engine, raw, this.id, this.version, this.isCrossEngine);
  }

  /** @returns {ToolTarget[]} every target, in engine order */
  get allTargets() {
    return this.engines.map((engine) => this.target(engine));
  }

  /** Does this tool declare the given engine at all? */
  supports(engine) {
    return Object.prototype.hasOwnProperty.call(this.targets, engine);
  }

  /**
   * Serializable summary for index.utool. Deliberately carries only engine NAMES:
   * per-engine floors and artifacts belong to the manifest, so the index stays a
   * small listing rather than a second copy of the data.
   */
  toSummary(manifestPath) {
    return {
      id: this.id,
      displayName: this.displayName,
      type: this.type,
      description: this.description,
      version: this.version,
      engines: this.engines,
      provides: this.provides,
      injects: this.injects,
      dependencies: this.dependencies,
      tags: this.tags,
      manifestPath: manifestPath ?? `payloads/${this.id}/tool.utool`,
    };
  }

  /** Absolute path of one engine's artifact inside a registry root. */
  artifactAbsolutePath(registryRoot, engine) {
    const target = this.target(engine);
    return target?.artifactPath ? path.join(registryRoot, target.artifactPath) : null;
  }
}
export function toManifest(doc) {
  return doc instanceof ToolManifest ? doc : new ToolManifest(doc);
}
