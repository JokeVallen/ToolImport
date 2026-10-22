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
import {
  assertInstallDirectory,
  assertSafePaths,
  commonDirectory,
  isSafeEntryName,
  placedArtifactDestination,
  relocatedPath,
  verifyArtifactBytes,
} from './artifacts.js';

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
 * @property {{path: string, size: number}[]} items what it would install, as project-relative
 *   destinations after any relocation - the plan is what the user confirms, so it must name the
 *   paths that will exist, not the paths inside the archive
 * @property {string} installRoot the directory this target installs into, derived from `items`
 * @property {string|null} into the directory the caller chose instead of `installRoot`, or null
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
 * @param {{into?: string|null}} [options] `into` moves every tool's payload to that directory
 * @returns {Promise<{tools: PlannedTool[], totalBytes: number, ok: boolean}>}
 */
export async function planInstallation(plan, source, containers, options = {}) {
  /** @type {PlannedTool[]} */
  const tools = [];
  let totalBytes = 0;
  let ok = plan.problems.length === 0;

  // Validated once, before any artifact is fetched: an unusable directory is a usage error,
  // and reporting it as "the download failed" later would blame the wrong thing.
  const into = options.into ? assertInstallDirectory(options.into) : null;

  for (const step of plan.steps) {
    const { manifest } = step;
    // A directory named on the command line is a statement about the tool the user ASKED for.
    // Applying it to every dependency as well would drop unrelated tools into one folder and
    // silently merge their contents; each of those keeps the layout its own manifest declares.
    const stepInto = into && (step.installedBecause ?? []).includes('user') ? into : null;

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
        installRoot: '',
        into: stepInto,
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

      // Where each entry lands in the PROJECT, which is what the user is confirming. For an
      // unpacked artifact the handler reports archive-relative names and contentRoot is applied
      // here; for a placed file the destination is already final.
      const landed = landedPaths(base, report.items);
      // Checked after contentRoot is applied: an entry name that is safe on its own becomes
      // unsafe once a declared root such as `../..` is glued in front of it.
      assertSafePaths(landed, `${base.id}/${base.engine}`, 'destinations');

      // The directory the tool occupies, derived from the paths themselves. `into` moves that
      // whole directory, so a payload keeps its internal layout instead of being scattered.
      const installRoot = commonDirectory(landed);
      const relocated = (index) =>
        base.into
          ? relocatedPath(landed[index], installRoot, base.into, `${base.id}/${base.engine}`)
          : landed[index];

      tools.push({
        ...base,
        installRoot,
        size: report.size,
        sha256: report.sha256,
        items: report.items.map((item, index) => ({ path: relocated(index), size: item.size })),
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
  /** @type {Map<string, {version: string, sha256: string, format: string|null, files: string[], engines: string[], installedBecause: string[], roots: string[]}>} */
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
      // The directory each engine's payload occupies. Recorded because it is the one thing a
      // receipt can say about a tool whose FILES have gone: "everything you wrote lived under
      // Assets/X" is what lets an uninstall explain a directory that is no longer where it was,
      // instead of reporting a clean removal that removed nothing.
      roots: [],
    };
    for (const file of files) {
      if (!receipt.files.includes(file)) receipt.files.push(file);
    }
    Object.assign(receipt.fileHashes, fileHashes);
    const root = tool.into ?? tool.installRoot;
    if (root && !receipt.roots.includes(root)) receipt.roots.push(root);
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
      installedRoots: [...receipt.roots].sort(),
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

  // The single decision of where this payload goes, taken once in the plan and obeyed here.
  // Recomputing the root in this phase is how the plan and the write would start disagreeing
  // about a directory the user chose.
  const relocate = (landed) =>
    tool.into ? relocatedPath(landed, tool.installRoot ?? '', tool.into, `${tool.id}/${tool.engine}`) : landed;

  if (tool.artifactType === ARTIFACT_TYPE.FILE) {
    const destination = relocate(tool.targetPath ?? '');
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
    const destination = relocate(placedArtifactDestination(declared, `${tool.id}/${tool.engine}`));
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
  return handler.extract(bytes, declared, createWriteContext(projectRoot, tool, relocate));
}

/**
 * Project-relative destination of each verified item, before any relocation.
 *
 * @param {PlannedTool} tool
 * @param {{path: string, size: number}[]} items
 * @returns {string[]}
 */
function landedPaths(tool, items) {
  // A placed container and a single file already name their destination in the project; only
  // an unpacked artifact reports entry names that still need the declared contentRoot.
  const alreadyPlaced = tool.artifactType === ARTIFACT_TYPE.FILE || tool.unpack === UNPACK.NONE;
  const contentRoot = String(tool.contentRoot ?? '').replace(/^[/\\]+|[/\\]+$/g, '');

  return items.map((item) => {
    const entry = String(item.path).replace(/\\/g, '/').replace(/^\.\//, '');
    if (alreadyPlaced) return entry;
    return contentRoot ? `${contentRoot}/${entry}` : entry;
  });
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
function createWriteContext(projectRoot, tool, relocate = (landed) => landed) {
  const contentRoot = String(tool.contentRoot ?? '').replace(/^[/\\]+|[/\\]+$/g, '');

  const relativeOf = (itemPath) => {
    const normalised = String(itemPath).replace(/\\/g, '/').replace(/^\.\//, '');
    // `relocate` is identity unless the caller chose a directory, so this is the same path the
    // handler always computed - and when a directory WAS chosen, the receipt, the plan and the
    // bytes all describe the relocated path rather than the registry's default one.
    return relocate(contentRoot ? `${contentRoot}/${normalised}` : normalised);
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
