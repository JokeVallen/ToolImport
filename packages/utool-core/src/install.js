/**
 * Install planning and execution.
 *
 * Two strictly separated phases:
 *
 *   planInstallation()  fetches and verifies every artifact for every engine in
 *                       the plan, and reports exactly what would be written.
 *                       Nothing touches the project. This is what --dry-run prints
 *                       and what a front end shows for confirmation.
 *
 *   executeInstall()    writes the payloads and records one receipt per tool.
 *
 * The separation is the point: a plan whose artifacts fail verification never
 * reaches the write phase, so a bad download cannot half-install a project.
 *
 * All container knowledge is delegated. The core writes single-file payloads; a
 * container is written by whichever handler is registered for its format, through
 * a write context that owns path resolution. A handler therefore never decides
 * where the project root is, and cannot write outside it by accident.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactError } from './errors.js';
import { ARTIFACT_TYPE, UNPACK } from './format.js';
import { isSafeEntryName, placedArtifactDestination, verifyArtifactBytes } from './artifacts.js';

/**
 * @typedef {Object} PlannedTool
 * @property {string} id
 * @property {string} version
 * @property {string} engine
 * @property {string} artifactType
 * @property {string|null} artifactPath
 * @property {string|null} artifactFormat
 * @property {number|null} size
 * @property {string|null} sha256
 * @property {{path: string, size: number}[]} items
 * @property {string|null} contentRoot
 * @property {string|null} targetPath
 * @property {string|null} subdirectory
 * @property {string} unpack "auto" or "none"; carried from the manifest so the write phase
 *   cannot disagree with the plan about whether a container is opened or placed
 * @property {boolean} editorOnly
 * @property {string[]} installedBecause
 * @property {boolean} alreadyInstalled
 * @property {string|null} skipped
 */

/**
 * Fetch and verify every artifact in a resolved plan.
 *
 * One planned tool is produced per (tool, engine) pair, because a cross-engine
 * tool installs a different artifact into each engine.
 *
 * @param {{steps: object[], problems: object[]}} plan
 * @param {{fetchArtifact: (p: string) => Promise<Buffer>}} source
 * @param {import('./containers.js').ContainerRegistry} containers
 * @returns {Promise<{tools: PlannedTool[], totalBytes: number, ok: boolean}>}
 */
export async function planInstallation(plan, source, containers) {
  /** @type {PlannedTool[]} */
  const tools = [];
  let totalBytes = 0;
  let ok = plan.problems.length === 0;

  for (const step of plan.steps) {
    const { manifest } = step;

    for (const engine of step.engines) {
      const target = manifest.target(engine);
      const base = {
        id: manifest.id,
        version: manifest.version,
        engine,
        artifactType: target.type,
        artifactPath: target.artifactPath,
        artifactFormat: target.format ?? null,
        size: null,
        sha256: null,
        items: [],
        contentRoot: target.contentRoot,
        targetPath: target.targetPath,
        subdirectory: target.subdirectory,
        // The plan is what the user confirms, so it has to record HOW the artifact lands.
        // Dropping this field is how `unpack: none` used to be planned as one placed file
        // and then executed as an extraction: the receipt named a file nobody wrote.
        unpack: target.artifact.unpack ?? UNPACK.AUTO,
        editorOnly: target.editorOnly,
        installedBecause: step.installedBecause,
        alreadyInstalled: step.alreadyInstalled,
        skipped: null,
      };

      // --- external: the caller resolves it, the core records where -----
      if (target.isExternal) {
        const external = target.external;
        tools.push({
          ...base,
          skipped:
            external?.url && external?.ref
              ? `external ${external.source} source (${external.url} @ ${external.ref}) is resolved by the caller`
              : 'external source is incomplete',
        });
        continue;
      }

      const declared = target.declaredArtifact;

      let bytes;
      try {
        bytes = await source.fetchArtifact(declared.path);
      } catch (cause) {
        ok = false;
        tools.push({ ...base, skipped: `fetch failed: ${cause.message}` });
        continue;
      }

      // Size, digest, container magic and destination safety. Throws on any
      // mismatch, which aborts the whole plan before a single byte is written.
      const report = verifyArtifactBytes(bytes, declared, containers, declared.path);
      totalBytes += report.size;

      tools.push({
        ...base,
        size: report.size,
        sha256: report.sha256,
        items: report.items.map((item) => ({ path: item.path, size: item.size })),
      });
    }
  }

  return { tools, totalBytes, ok };
}

/**
 * Execute a verified plan.
 *
 * @param {{tools: PlannedTool[]}} report
 * @param {{
 *   projectRoot: string,
 *   source: {fetchArtifact: (p: string) => Promise<Buffer>},
 *   containers: import('./containers.js').ContainerRegistry,
 *   receiptStore: import('./receipts.js').ReceiptStore,
 *   registryRef?: string|null,
 *   registryCommit?: string|null,
 *   now?: () => Date,
 * }} options
 */
export async function executeInstall(report, options) {
  const { projectRoot, source, containers, receiptStore } = options;
  const now = options.now ?? (() => new Date());

  /** @type {{id: string, engine: string, files: string[]}[]} */
  const installed = [];
  /** @type {{id: string, engine: string, reason: string}[]} */
  const skipped = [];
  let bytes = 0;

  // One receipt per TOOL, not per (tool, engine): installing is one decision, so
  // uninstalling should be one decision too, whatever engines it touched.
  /** @type {Map<string, {version: string, sha256: string, format: string|null, files: string[], engines: string[], installedBecause: string[]}>} */
  const byTool = new Map();

  for (const tool of report.tools) {
    if (tool.skipped) {
      skipped.push({ id: tool.id, engine: tool.engine, reason: tool.skipped });
      continue;
    }

    const artifactBytes = await source.fetchArtifact(tool.artifactPath);
    bytes += artifactBytes.length;

    const written = await writePayload(artifactBytes, tool, containers, projectRoot);

    const files = written
      .filter((item) => !item.directory)
      .map((item) => String(item.path).replace(/\\/g, '/'));

    // Record each installed file's digest so a later uninstall can tell "this is the
    // file we installed" from "the user has edited this since". Without it, uninstall
    // cannot distinguish our file from the user's work, and the no-pollution claim
    // holds only until somebody touches something.
    //
    // The digest is taken from the file on disk rather than from the archive entry, so
    // it also proves the write actually landed with the bytes we intended.
    const fileHashes = {};
    for (const file of files) {
      try {
        fileHashes[file] = sha256Of(await readFile(path.join(projectRoot, file)));
      } catch {
        // A file we cannot read back is not recordable; uninstall will treat it as
        // already gone rather than as modified.
      }
    }

    installed.push({ id: tool.id, engine: tool.engine, files });

    const receipt = byTool.get(tool.id) ?? {
      version: tool.version,
      sha256: tool.sha256 ?? sha256Of(artifactBytes),
      format: tool.artifactFormat,
      files: [],
      fileHashes: {},
      engines: [],
      installedBecause: tool.installedBecause,
    };
    for (const file of files) {
      if (!receipt.files.includes(file)) receipt.files.push(file);
    }
    Object.assign(receipt.fileHashes, fileHashes);
    if (!receipt.engines.includes(tool.engine)) receipt.engines.push(tool.engine);
    byTool.set(tool.id, receipt);
  }

  for (const [toolId, receipt] of byTool) {
    await receiptStore.write({
      toolId,
      version: receipt.version,
      artifactSha256: receipt.sha256,
      artifactFormat: receipt.format,
      installedAtUtc: now().toISOString(),
      registryRef: options.registryRef ?? null,
      registryCommit: options.registryCommit ?? null,
      installedEngines: [...receipt.engines].sort(),
      installedFiles: [...receipt.files].sort(),
      installedFileHashes: receipt.fileHashes,
      installedByTools: receipt.installedBecause,
    });
  }

  return { installed, skipped, bytes };
}

/**
 * Write one engine's payload and return the project-relative destinations.
 *
 * Three cases, in the order they must be decided:
 *   file      no container at all, just a destination
 *   none      the container is placed as a file, not opened
 *   auto      the registered handler for the format opens it
 */
async function writePayload(bytes, tool, containers, projectRoot) {
  const declared = declaredOf(tool);

  if (tool.artifactType === ARTIFACT_TYPE.FILE) {
    const destination = tool.targetPath ?? tool.items[0]?.path;
    if (!destination) {
      throw new ArtifactError(
        'E-ARTIFACT-TARGETPATH',
        `${tool.id}/${tool.engine}: single-file payload has no targetPath`,
      );
    }
    const absolute = path.join(projectRoot, destination);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return [{ path: destination, size: bytes.length }];
  }

  if (tool.artifactFormat === null || tool.artifactFormat === undefined) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT',
      `${tool.id}/${tool.engine}: artifact type '${tool.artifactType}' needs a format`,
    );
  }

  if (declared.unpack === UNPACK.NONE) {
    // Same decision the plan already reported: the container is one file at targetPath.
    const destination = placedArtifactDestination(declared, `${tool.id}/${tool.engine}`);
    const absolute = path.join(projectRoot, destination);
    if (!isSafeEntryName(destination)) {
      throw new ArtifactError(
        'E-ARTIFACT-UNSAFE',
        `${tool.id}/${tool.engine}: refusing to write outside the project: ${destination}`,
      );
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return [{ path: destination, size: bytes.length }];
  }

  const handler = containers.for(String(tool.artifactFormat));
  if (!handler) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT-UNSUPPORTED',
      `${tool.id}/${tool.engine}: no handler registered for format '${tool.artifactFormat}'. ` +
        `Registered: ${containers.formats().join(', ') || '(none)'}`,
    );
  }
  return handler.extract(bytes, declared, createWriteContext(projectRoot, tool));
}

/** Reconstruct the declared-artifact shape a handler expects. */
function declaredOf(tool) {
  return {
    type: tool.artifactType,
    format: tool.artifactFormat,
    path: tool.artifactPath,
    size: tool.size,
    sha256: tool.sha256,
    contentRoot: tool.contentRoot,
    targetPath: tool.targetPath,
    subdirectory: tool.subdirectory,
    unpack: tool.unpack,
    files: [],
    editorOnly: tool.editorOnly,
  };
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The write context handed to container handlers.
 *
 * It owns contentRoot and the project root, so a handler reports a relative path
 * and this decides the absolute one. That keeps path safety in one place instead
 * of trusting each adapter to get it right.
 */
function createWriteContext(projectRoot, tool) {
  const contentRoot = String(tool.contentRoot ?? '').replace(/^[/\\]+|[/\\]+$/g, '');

  const relativeOf = (itemPath) => {
    const normalised = String(itemPath).replace(/\\/g, '/').replace(/^\.\//, '');
    return contentRoot ? `${contentRoot}/${normalised}` : normalised;
  };

  return {
    projectRoot,
    engine: tool.engine,
    toolId: tool.id,

    /** Project-relative destination, for the receipt. */
    relative: relativeOf,

    /** Absolute destination, refused when it would leave the project. */
    resolve(itemPath) {
      const relative = relativeOf(itemPath);
      if (!isSafeEntryName(relative)) {
        throw new ArtifactError(
          'E-ARTIFACT-UNSAFE',
          `${tool.id}/${tool.engine}: refusing to write outside the project: ${relative}`,
        );
      }
      return path.join(projectRoot, relative);
    },

    async ensureDirectory(absolutePath) {
      await mkdir(absolutePath, { recursive: true });
    },

    /** Write one item that carries its own bytes. */
    async writeItem(item) {
      if (!item.data) {
        throw new ArtifactError(
          'E-HANDLER-CONTRACT',
          `container handler returned an item without bytes for '${item.path}'`,
        );
      }
      const destination = this.resolve(item.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, item.data);
    },
  };
}

export { ARTIFACT_TYPE, UNPACK };
