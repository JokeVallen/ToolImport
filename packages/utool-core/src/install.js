/**
 * Install planning and execution.
 *
 * Two strictly separated phases:
 *
 *   planInstallation()  fetches and verifies every artifact in the plan, and
 *                       reports exactly what would be written. Nothing touches
 *                       the project. This is what `--dry-run` prints and what
 *                       the Unity front end shows for confirmation.
 *
 *   executeInstall()    writes the files and records one receipt per tool.
 *
 * The separation is the point: a plan whose artifacts fail verification never
 * reaches the write phase, so a half-installed project cannot happen through a
 * bad download.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { ArtifactError } from './errors.js';
import { ARTIFACT_FORMAT } from './format.js';
import { isSafeEntry, readUnitypackagePathnames, verifyArtifactBytes } from './artifacts.js';
import { readAllEntries as readZipEntries } from './zip.js';

/**
 * @typedef {Object} PlannedFile
 * @property {string} path project-relative destination
 * @property {number} size
 */

/**
 * @typedef {Object} PlannedTool
 * @property {string} id
 * @property {string} version
 * @property {string} sourceKind
 * @property {string|null} artifactPath
 * @property {string|null} artifactFormat
 * @property {number|null} size
 * @property {string|null} sha256
 * @property {PlannedFile[]} files
 * @property {string|null} contentRoot
 * @property {boolean} editorOnly
 * @property {string[]} installedBecause
 * @property {boolean} alreadyInstalled
 * @property {string|null} skipped reason, when the tool cannot be installed by this backend
 */

/**
 * @typedef {Object} InstallPlanReport
 * @property {PlannedTool[]} tools
 * @property {number} totalBytes
 * @property {boolean} ok
 */

/**
 * Fetch and verify every artifact in a resolved plan.
 *
 * @param {import('./resolver.js').Plan} plan
 * @param {{fetchArtifact: (p: string) => Promise<Buffer>}} source
 * @returns {Promise<InstallPlanReport>}
 */
export async function planInstallation(plan, source) {
  /** @type {PlannedTool[]} */
  const tools = [];
  let totalBytes = 0;
  let ok = plan.problems.length === 0;

  for (const step of plan.steps) {
    const { manifest } = step;

    if (manifest.isExternal) {
      // The core deliberately does not shell out to git. Resolving an external
      // git source is the caller's job (CLI wrapper or the Unity front end),
      // which then hands the resolved tree back in.
      tools.push({
        id: manifest.id,
        version: manifest.version,
        sourceKind: manifest.sourceKind,
        artifactPath: null,
        artifactFormat: null,
        size: null,
        sha256: null,
        files: [],
        contentRoot: manifest.contentRoot ?? null,
        editorOnly: manifest.editorOnly,
        installedBecause: step.installedBecause,
        alreadyInstalled: step.alreadyInstalled,
        skipped: manifest.isGit
          ? `external git source (${manifest.git.url} @ ${manifest.git.ref}) is resolved by the caller`
          : 'external source',
      });
      continue;
    }

    const declared = manifest.artifact;
    if (!declared) {
      ok = false;
      tools.push({
        id: manifest.id,
        version: manifest.version,
        sourceKind: manifest.sourceKind,
        artifactPath: manifest.artifactPath,
        artifactFormat: manifest.artifactFormat,
        size: null,
        sha256: null,
        files: [],
        contentRoot: manifest.contentRoot ?? null,
        editorOnly: manifest.editorOnly,
        installedBecause: step.installedBecause,
        alreadyInstalled: step.alreadyInstalled,
        skipped: 'manifest declares kind: bundled but carries no artifacts entry',
      });
      continue;
    }

    let bytes;
    try {
      bytes = await source.fetchArtifact(declared.path);
    } catch (cause) {
      ok = false;
      tools.push({
        id: manifest.id,
        version: manifest.version,
        sourceKind: manifest.sourceKind,
        artifactPath: declared.path,
        artifactFormat: declared.format,
        size: declared.size,
        sha256: null,
        files: [],
        contentRoot: manifest.contentRoot ?? null,
        editorOnly: manifest.editorOnly,
        installedBecause: step.installedBecause,
        alreadyInstalled: step.alreadyInstalled,
        skipped: `fetch failed: ${cause.message}`,
      });
      continue;
    }

    // Throws on any mismatch, which aborts the whole plan before any write.
    const report = verifyArtifactBytes(bytes, declared, declared.path);
    totalBytes += report.size;

    tools.push({
      id: manifest.id,
      version: manifest.version,
      sourceKind: manifest.sourceKind,
      artifactPath: declared.path,
      artifactFormat: declared.format,
      size: report.size,
      sha256: report.sha256,
      files: report.files.map((file) => ({ path: file, size: 0 })),
      contentRoot: manifest.contentRoot ?? null,
      editorOnly: manifest.editorOnly,
      installedBecause: step.installedBecause,
      alreadyInstalled: step.alreadyInstalled,
      skipped: null,
    });
  }

  return { tools, totalBytes, ok };
}

/**
 * Execute a verified plan.
 *
 * @param {InstallPlanReport} report
 * @param {{
 *   projectRoot: string,
 *   source: {fetchArtifact: (p: string) => Promise<Buffer>},
 *   receiptStore: import('./receipts.js').ReceiptStore,
 *   registryRef?: string|null,
 *   registryCommit?: string|null,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<{installed: {id: string, files: string[]}[], skipped: {id: string, reason: string}[], bytes: number}>}
 */
export async function executeInstall(report, options) {
  const { projectRoot, source, receiptStore } = options;
  const now = options.now ?? (() => new Date());

  /** @type {{id: string, files: string[]}[]} */
  const installed = [];
  /** @type {{id: string, reason: string}[]} */
  const skipped = [];
  let bytes = 0;

  for (const tool of report.tools) {
    if (tool.skipped) {
      skipped.push({ id: tool.id, reason: tool.skipped });
      continue;
    }

    const artifactBytes = await source.fetchArtifact(tool.artifactPath);
    let written;

    if (tool.artifactFormat === ARTIFACT_FORMAT.UNITYPACKAGE) {
      written = await extractUnitypackage(artifactBytes, projectRoot);
    } else if (tool.artifactFormat === ARTIFACT_FORMAT.ZIP) {
      written = await extractZip(artifactBytes, projectRoot, tool.contentRoot);
    } else {
      throw new ArtifactError(
        'E-ARTIFACT-FORMAT',
        `${tool.id}: unsupported artifact format ${JSON.stringify(tool.artifactFormat)}`,
      );
    }

    bytes += artifactBytes.length;

    await receiptStore.write({
      toolId: tool.id,
      version: tool.version,
      artifactSha256: tool.sha256 ?? sha256(artifactBytes),
      artifactFormat: tool.artifactFormat,
      installedAtUtc: now().toISOString(),
      registryRef: options.registryRef ?? null,
      registryCommit: options.registryCommit ?? null,
      installedFiles: written,
      installedByTools: tool.installedBecause,
    });

    installed.push({ id: tool.id, files: written });
  }

  return { installed, skipped, bytes };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Expand a .unitypackage into the project.
 *
 * Each GUID folder contributes one destination: its `pathname`. Destinations are
 * already project-relative (they begin with `Assets/`), so no contentRoot is
 * applied -- applying one would double-prefix.
 *
 * `asset.meta` accompanies `asset` in the archive. Unity regenerates metadata on
 * import, and writing a stale .meta over an existing file is worse than letting
 * the editor create a fresh one, so only the asset is written.
 *
 * @returns {Promise<string[]>} project-relative paths written
 */
export async function extractUnitypackage(gzBytes, projectRoot) {
  const raw = gunzipSync(gzBytes);
  /** @type {Map<string, {pathname: string, asset: Buffer|null}>} */
  const folders = new Map();

  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const body = raw.subarray(offset + 512, offset + 512 + size);

    const slash = fullName.lastIndexOf('/');
    if (slash > 0) {
      const guid = fullName.slice(0, slash);
      const leaf = fullName.slice(slash + 1);
      if (!folders.has(guid)) folders.set(guid, { pathname: '', asset: null });
      const folder = folders.get(guid);
      if (leaf === 'pathname') folder.pathname = body.toString('utf8').replace(/\0+$/, '').trim();
      else if (leaf === 'asset') folder.asset = Buffer.from(body);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  const written = [];
  for (const [, folder] of folders) {
    if (!folder.pathname) continue;
    if (!isSafeEntry(folder.pathname)) {
      throw new ArtifactError(
        'E-ARTIFACT-UNSAFE',
        `pathname '${folder.pathname}' escapes the project root`,
      );
    }
    const destination = path.join(projectRoot, folder.pathname);

    if (folder.asset === null || folder.asset.length === 0) {
      // A folder entry in the package: create the directory, nothing to write.
      await mkdir(destination, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, folder.asset);
    written.push(folder.pathname.replace(/\\/g, '/'));
  }
  return written.sort();
}

/**
 * Extract a plain zip into the project.
 *
 * @param {Buffer} zipBytes
 * @param {string} projectRoot
 * @param {string|null} contentRoot where to place it, relative to the project
 * @returns {Promise<string[]>} project-relative paths written
 */
export async function extractZip(zipBytes, projectRoot, contentRoot) {
  const prefix = (contentRoot ?? '').replace(/^[/\\]+|[/\\]+$/g, '');
  const written = [];

  for (const entry of readZipEntries(zipBytes)) {
    const normalised = entry.name.replace(/\\/g, '/');
    if (!isSafeEntry(normalised)) {
      throw new ArtifactError('E-ARTIFACT-UNSAFE', `zip entry '${entry.name}' escapes the extraction root`);
    }
    const relative = prefix ? `${prefix}/${normalised}` : normalised;
    const destination = path.join(projectRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
    written.push(relative);
  }
  return written.sort();
}

function readNullTerminated(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

export { readUnitypackagePathnames };
