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
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
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
   * Which installed tools still need a tool that is about to be removed?
   *
   * Derived from the receipts, not from the registry. A receipt records
   * `installedByTools`: the ids that caused this tool to be pulled in. If one of
   * those is still installed, removing this tool breaks it.
   *
   * Reading local state matters here. The registry says a tool *may* be depended on;
   * the receipts say it *is*, in THIS project. Only the second is a reason to refuse.
   *
   * @param {string[]} toolIds tools being removed
   * @returns {Promise<{tool: string, stillNeededBy: string[]}[]>} one entry per blocked tool
   */
  async blockedByDependents(toolIds) {
    const all = await this.list();
    const going = new Set(toolIds);
    const blocked = [];

    for (const id of toolIds) {
      const receipt = all.find((entry) => entry.toolId === id);
      if (!receipt) continue;

      // `['user']` means the user asked for it directly, so nothing depends on it.
      const dependents = (receipt.installedByTools ?? []).filter(
        (dependent) => dependent !== 'user' && !going.has(dependent) && all.some((e) => e.toolId === dependent),
      );

      if (dependents.length > 0) {
        blocked.push({ tool: id, stillNeededBy: [...new Set(dependents)].sort() });
      }
    }
    return blocked;
  }

  /**
   * Tools that would become orphaned if `toolIds` were removed.
   *
   * The inverse of the above: a dependency pulled in automatically whose last
   * dependent is going away. Nothing is removed automatically - this only reports,
   * so the user can decide in the same breath as the uninstall they asked for.
   *
   * @param {string[]} toolIds
   * @returns {Promise<string[]>} tool ids, sorted
   */
  async orphanedAfter(toolIds) {
    const all = await this.list();
    const going = new Set(toolIds);
    const orphans = [];

    for (const receipt of all) {
      if (going.has(receipt.toolId)) continue;
      const dependents = (receipt.installedByTools ?? []).filter((id) => id !== 'user');
      // Only a tool that was pulled in FOR something can be orphaned by that
      // something leaving; a user-installed tool is never "orphaned".
      if (dependents.length === 0) continue;
      if (dependents.every((id) => going.has(id))) orphans.push(receipt.toolId);
    }
    return orphans.sort();
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
   * Execute an uninstall plan.
   *
   * The plan from {@link planUninstall} is authoritative: this removes exactly the
   * files it lists and nothing else. Three rules make that safe.
   *
   *  1. Every path is resolved against the project root and rejected if it escapes.
   *     A receipt is a file on disk, and a hand-edited or malicious one must not be
   *     able to delete anything outside the project.
   *  2. A file still claimed by a remaining receipt is never removed, so a shared
   *     file survives until the last dependent leaves.
   *  3. A directory is removed only when it is empty afterwards, and never the
   *     project root or `Assets` itself. Recursively deleting a directory would
   *     take unrelated work with it; leaving an empty one behind costs nothing.
   *
   * Receipts are deleted last, so an interruption leaves the receipt to describe
   * what is still on disk rather than losing the record of a half-done removal.
   *
   * @param {{delete: string[], missingReceipts: string[]}} plan
   * @param {{projectRoot: string, receiptStore: ReceiptStore, toolIds?: string[]}} options
   * @returns {Promise<{removed: string[], failed: {file: string, reason: string}[], directories: string[], receipts: string[]}>}
   */
  async executeUninstall(plan, options) {
    const { projectRoot, receiptStore } = options;
    const toolIds = options.toolIds ?? [];

    const root = path.resolve(projectRoot);
    const removed = [];
    const failed = [];
    /** @type {Set<string>} */
    const touchedDirectories = new Set();

    for (const relative of plan.delete ?? []) {
      const absolute = path.resolve(root, relative);

      // Confinement check. `path.relative` is empty when the paths are equal, and
      // starts with '..' when the target is outside the root.
      const rel = path.relative(root, absolute);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        failed.push({ file: relative, reason: 'outside the project root' });
        continue;
      }

      try {
        await rm(absolute, { force: true });
        removed.push(relative);
        // Remember the parent so empty directories can be tidied afterwards.
        touchedDirectories.add(path.dirname(absolute));
      } catch (cause) {
        failed.push({ file: relative, reason: cause.message });
      }
    }

    // Remove now-empty directories, deepest first.
    //
    // Only three paths are protected: the project root, `Assets`, and `Assets/Editor`.
    // Those are structural -- a Unity project needs them and they routinely hold
    // unrelated work -- so a tool must not remove them. Everything deeper is fair
    // game once it is EMPTY, which is what makes the tool's own folder disappear
    // while a folder that still holds the user's files stays.
    const directories = [];
    const protectedPaths = new Set([
      root,
      path.join(root, 'Assets'),
      path.join(root, 'Assets', 'Editor'),
    ]);
    const ordered = [...touchedDirectories].sort((a, b) => b.length - a.length);
    for (const directory of ordered) {
      let current = directory;
      while (
        current.length > root.length &&
        current.startsWith(root) &&
        !protectedPaths.has(current)
      ) {
        try {
          // Unity writes a `.meta` beside every asset AND every folder it imports.
          // Those are not in the receipt, because the installer never wrote them.
          //
          // Two leftovers result, and they need different handling:
          //
          //   Core/Guard.cs.meta   inside the folder, from the file we just deleted
          //   Core.meta            BESIDE the folder, and this is the one that matters
          //
          // A folder's own `.meta` is Unity's record of a folder it will re-create on
          // the next Refresh. That is why an "emptied" directory came back. So a
          // directory is removed when it holds nothing but `.meta` leftovers, and its
          // sibling `.meta` goes with it.
          const entries = await readdir(current);
          const strays = entries.filter((entry) => entry.endsWith('.meta'));
          if (entries.length > strays.length) break;
          for (const stray of strays) {
            await rm(path.join(current, stray), { force: true });
          }

          // rmdir, NOT rm: `rm` refuses a directory without `recursive`, and
          // `recursive` here would delete work the user put in it. The emptiness
          // check above is what makes this safe, so only an EMPTY directory goes.
          await rmdir(current);

          // The folder's own .meta sits next to it, not inside it.
          await rm(`${current}.meta`, { force: true });
          directories.push(path.relative(root, current).replace(/\\/g, '/'));
        } catch {
          break;
        }
        current = path.dirname(current);
      }
    }

    // Last, so an interrupted run still has a receipt describing what remains.
    const receipts = [];
    for (const id of toolIds) {
      if ((plan.missingReceipts ?? []).includes(id)) continue;
      try {
        await receiptStore.remove(id);
        receipts.push(id);
      } catch (cause) {
        failed.push({ file: `receipt:${id}`, reason: cause.message });
      }
    }

    return { removed, failed, directories, receipts };
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
