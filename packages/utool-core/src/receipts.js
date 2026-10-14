/**
 * Install receipts, and the version pointer that makes an update reversible.
 *
 * One receipt per installed TOOL, under
 * `<project>/Library/DevCatToolRegistry/receipts/<toolId>.yaml`, is what makes
 * uninstall exact: a file is removed only when no remaining receipt still claims
 * it, so a shared file survives until the last dependent leaves.
 *
 * Receipts live under Library/, which Unity never commits, so this state cannot
 * leak into a consumer's version control.
 *
 * THE VERSION POINTER (borrowed from cordis, where a plugin keeps a current and a
 * next pointer so a failed activation can be rolled back): a receipt records
 * `previousSha256`, the artifact this install replaced. Without it, updating a
 * tool is a one-way door - the old bytes are gone and the old receipt no longer
 * describes what is on disk. With it, an update that misbehaves can be rolled back
 * to the recorded digest, and `planRollback` says exactly which files must be
 * re-fetched to do so.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { ArtifactError, DocumentError } from './errors.js';
import { FILE_NAMES, FORMAT_VERSION, KIND, RECEIPT_DIR } from './format.js';
import { checkHeader, loadUtool } from './loader.js';

/**
 * @typedef {Object} Receipt
 * @property {string} toolId
 * @property {string} version
 * @property {string} artifactSha256
 * @property {string|null} artifactFormat
 * @property {string} installedAtUtc
 * @property {string|null} registryRef
 * @property {string|null} registryCommit
 * @property {string[]} installedEngines engines this tool was installed into
 * @property {string[]} installedFiles project-relative paths
 * @property {string[]} installedByTools ids that required this, or ['user']
 * @property {string|null} previousSha256 the artifact this install replaced
 */

export class ReceiptStore {
  /** @param {string} projectRoot */
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.dir = path.join(this.projectRoot, RECEIPT_DIR);
  }

  /** @returns {string} absolute path of one tool's receipt */
  pathFor(toolId) {
    return path.join(this.dir, FILE_NAMES.receiptFor(toolId));
  }

  /**
   * Write a receipt.
   *
   * `previousSha256` is carried over from whatever receipt already exists, unless
   * the caller states it explicitly. That is what makes the pointer automatic: an
   * update by the normal install path records what it replaced without the caller
   * having to think about it.
   *
   * @param {Receipt} receipt
   * @returns {Promise<string>} the path written
   */
  async write(receipt) {
    await mkdir(this.dir, { recursive: true });

    let previous = receipt.previousSha256 ?? null;
    if (receipt.previousSha256 === undefined) {
      const existing = await this.read(receipt.toolId).catch(() => null);
      // Only a genuine version change creates a pointer. Re-installing the same
      // artifact must not overwrite the pointer with itself, or the rollback
      // target would become the broken version.
      if (existing && existing.artifactSha256 !== receipt.artifactSha256) {
        previous = existing.artifactSha256;
      } else if (existing) {
        previous = existing.previousSha256 ?? null;
      }
    }

    const doc = {
      kind: KIND.RECEIPT,
      formatVersion: FORMAT_VERSION,
      toolId: receipt.toolId,
      version: receipt.version,
      artifactSha256: receipt.artifactSha256,
      artifactFormat: receipt.artifactFormat ?? null,
      installedAtUtc: receipt.installedAtUtc,
      registryRef: receipt.registryRef ?? null,
      registryCommit: receipt.registryCommit ?? null,
      installedEngines: [...(receipt.installedEngines ?? [])].sort(),
      installedFiles: [...(receipt.installedFiles ?? [])].sort(),
    // Per-file digests as written, so a later uninstall can tell our file from one the
    // user has since edited. Absent for receipts written before this was recorded; the
    // uninstall plan treats a missing digest as "cannot judge" rather than as drift.
    installedFileHashes: receipt.installedFileHashes ?? {},
      installedByTools: receipt.installedByTools ?? ['user'],
      previousSha256: previous,
    };

    const header =
      '# Import receipt written by the DevCatToolRegistry import tool.\n' +
      '# Do not hand-edit: it drives uninstall, reference counting and rollback.\n' +
      '# previousSha256 is the version pointer: the artifact this install replaced.\n';
    const target = this.pathFor(receipt.toolId);
    // lineWidth: 0 keeps long paths on one line, which is what makes it readable.
    await writeFile(target, `${header}\n${stringifyYaml(doc, { lineWidth: 0 })}`, 'utf8');
    return target;
  }

  /**
   * @returns {Promise<Receipt[]>} every receipt found, sorted by tool id
   */
  async list() {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir);
    const receipts = [];
    for (const name of entries.filter((entry) => entry.endsWith('.yaml')).sort()) {
      const file = path.join(this.dir, name);
      receipts.push(this.#parse(file, name));
    }
    return receipts;
  }

  /**
   * @param {string} toolId
   * @returns {Promise<Receipt|null>}
   */
  async read(toolId) {
    const file = this.pathFor(toolId);
    if (!existsSync(file)) return null;
    return this.#parse(file, path.basename(file));
  }

  #parse(file, name) {
    try {
      const doc = loadUtool(file);
      checkHeader(doc, file, KIND.RECEIPT);
      return doc;
    } catch (cause) {
      throw new DocumentError(
        'E-RECEIPT-INVALID',
        `receipt ${name} is unreadable and must be repaired or removed: ${cause.message}`,
      );
    }
  }

  /** @param {string} toolId */
  async remove(toolId) {
    await rm(this.pathFor(toolId), { force: true });
  }

  /**
   * Which installed tools claim a given project-relative file?
   *
   * @param {string} relativeFile
   * @returns {Promise<string[]>} tool ids, sorted
   */
  async claimantsOf(relativeFile) {
    const normalized = normalize(relativeFile);
    const receipts = await this.list();
    return receipts
      .filter((receipt) => (receipt.installedFiles ?? []).some((file) => normalize(file) === normalized))
      .map((receipt) => receipt.toolId)
      .sort();
  }

  /**
   * Plan an uninstall.
   *
   * A file is shared when more than one receipt claims it, so it survives until
   * the last claimant leaves. Nothing is deleted here; this only reports.
   *
   * @param {string[]} toolIds
   * @returns {Promise<{delete: string[], keep: {file: string, claimedBy: string[]}[], missingReceipts: string[]}>}
   */
  async planUninstall(toolIds) {
    const all = await this.list();
    const going = new Set(toolIds);
    const staying = all.filter((receipt) => !going.has(receipt.toolId));

    const missingReceipts = toolIds.filter((id) => !all.some((receipt) => receipt.toolId === id));

    /** @type {Map<string, string[]>} */
    const survivors = new Map();
    for (const receipt of staying) {
      for (const file of receipt.installedFiles ?? []) {
        const normalized = normalize(file);
        if (!survivors.has(normalized)) survivors.set(normalized, []);
        survivors.get(normalized).push(receipt.toolId);
      }
    }

    const toDelete = [];
    const toKeep = [];
    /** Files recorded in a receipt that are no longer on disk. */
    const alreadyGone = [];
    /**
     * Files whose bytes differ from what was installed.
     *
     * These are still deleted, but they are listed separately first, because the ownership rule is
     * about the DIRECTORY rather than about anybody's intent: a tool owns everything it wrote under
     * the paths it installed into, and uninstalling removes it. What a user changed inside a tool's
     * own directory is theirs to have changed, and the fix for it - reinstalling - is a path we
     * support, whereas guessing whether a modified file "was really theirs" is not decidable from
     * the data.
     *
     * Listing them is not a softening of that rule. It is the one confirmation that stops a silent
     * destructive action from being a surprise, and it costs nothing.
     * @type {{file: string, expected: string|null, actual: string}[]}
     */
    const modified = [];

    /** Resolve a recorded relative path against the project root. */
    const absoluteOf = (relative) => path.join(this.projectRoot, relative);

    async function digestOf(relative) {
      try {
        return sha256(await readFile(absoluteOf(relative)));
      } catch {
        return null;
      }
    }

    for (const receipt of all.filter((entry) => going.has(entry.toolId))) {
      const recorded = receipt.installedFileHashes ?? {};
      for (const file of receipt.installedFiles ?? []) {
        const normalized = normalize(file);
        const claimedBy = survivors.get(normalized);
        if (claimedBy && claimedBy.length > 0) {
          toKeep.push({ file: normalized, claimedBy: [...claimedBy].sort() });
          continue;
        }

        const onDisk = await digestOf(normalized);
        const expected = recorded[normalized] ?? null;

        if (onDisk === null) {
          // Not on disk. Harmless to include in the delete list - removing a path that
          // does not exist is a no-op - but recorded separately, because a receipt that
          // claims a file which is gone means either the user removed it or an earlier
          // uninstall was partial, and the count should not be quietly short.
          alreadyGone.push(normalized);
        } else if (expected !== null && expected !== onDisk) {
          // Edited since install. Still deleted, because the tool owns this directory - but
          // recorded so the caller can show what is about to go before it goes.
          modified.push({ file: normalized, expected, actual: onDisk });
        }

        if (!toDelete.includes(normalized)) toDelete.push(normalized);
      }
    }

    toDelete.sort();
    alreadyGone.sort();
    modified.sort((a, b) => a.file.localeCompare(b.file));
    return { delete: toDelete, keep: toKeep, missingReceipts, alreadyGone, modified };
  }

  /**
   * Can this tool be rolled back, and to what?
   *
   * @param {string} toolId
   * @returns {Promise<{ok: boolean, reason?: string, toolId: string, from: string|null, to: string|null, files: string[]}>}
   */
  async planRollback(toolId) {
    const receipt = await this.read(toolId);
    if (!receipt) {
      return {
        ok: false,
        reason: `no receipt for '${toolId}', so there is nothing to roll back to`,
        toolId,
        from: null,
        to: null,
        files: [],
      };
    }
    if (!receipt.previousSha256) {
      return {
        ok: false,
        reason:
          `'${toolId}' has no previous version recorded; it was installed rather than updated, ` +
          `so there is no rollback target`,
        toolId,
        from: receipt.artifactSha256,
        to: null,
        files: [],
      };
    }
    return {
      ok: true,
      toolId,
      from: receipt.artifactSha256,
      to: receipt.previousSha256,
      // The caller re-fetches and re-installs this artifact to perform the
      // rollback; the receipt records what the current files are so the rollback
      // can report what it replaced.
      files: receipt.installedFiles ?? [],
    };
  }

  /**
   * Clear the version pointer after a successful rollback.
   *
   * A pointer is only useful while it describes an untried alternative. Once the
   * rollback has been taken, keeping it would offer the same broken version again
   * as a "rollback" from the restored one.
   *
   * @param {string} toolId
   */
  async clearRollback(toolId) {
    const receipt = await this.read(toolId);
    if (!receipt) {
      throw new ArtifactError('E-RECEIPT-MISSING', `no receipt for '${toolId}'`);
    }
    await this.write({ ...receipt, previousSha256: null });
  }

  /**
   * A digest-keyed index of everything installed, for an audit view.
   *
   * @returns {Promise<{totalTools: number, totalFiles: number, byDigest: Map<string, string[]>}>}
   */
  async summary() {
    const receipts = await this.list();
    /** @type {Map<string, string[]>} */
    const byDigest = new Map();
    let totalFiles = 0;

    for (const receipt of receipts) {
      const digest = receipt.artifactSha256 ?? '(unknown)';
      if (!byDigest.has(digest)) byDigest.set(digest, []);
      byDigest.get(digest).push(receipt.toolId);
      totalFiles += (receipt.installedFiles ?? []).length;
    }

    return { totalTools: receipts.length, totalFiles, byDigest };
  }
}

/** Normalise a project-relative path for comparison across platforms. */
function normalize(file) {
  return String(file).replace(/\\/g, '/');
}

/** Lower-case hex sha256 of a buffer, matching the digest form used in manifests. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export { readFile };
