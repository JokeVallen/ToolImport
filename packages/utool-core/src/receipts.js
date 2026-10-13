/**
 * Install receipts.
 *
 * One receipt per installed tool, under
 * `<project>/Library/DevCatToolRegistry/receipts/<toolId>.utool`, is what makes
 * uninstall exact: a file is only removed when no remaining receipt still claims
 * it, and a file the user has since modified is reported rather than deleted.
 *
 * Receipts live under Library/, which Unity never commits, so this state cannot
 * leak into a consumer's version control.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { DocumentError, EXIT } from './errors.js';
import { FILE_NAMES, FORMAT_VERSION, KIND, RECEIPT_DIR } from './format.js';
import { loadUtool, checkHeader } from './loader.js';

/**
 * @typedef {Object} Receipt
 * @property {string} toolId
 * @property {string} version
 * @property {string} artifactSha256
 * @property {string} artifactFormat
 * @property {string} installedAtUtc
 * @property {string|null} registryRef
 * @property {string|null} registryCommit
 * @property {string[]} installedFiles project-relative paths
 * @property {string[]} installedByTools ids that required this, or ['user']
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
   * @param {Receipt} receipt
   * @returns {Promise<string>} the path written
   */
  async write(receipt) {
    await mkdir(this.dir, { recursive: true });
    const doc = {
      kind: KIND.RECEIPT,
      formatVersion: FORMAT_VERSION,
      toolId: receipt.toolId,
      version: receipt.version,
      artifactSha256: receipt.artifactSha256,
      artifactFormat: receipt.artifactFormat,
      installedAtUtc: receipt.installedAtUtc,
      registryRef: receipt.registryRef,
      registryCommit: receipt.registryCommit,
      installedFiles: receipt.installedFiles,
      installedByTools: receipt.installedByTools,
    };
    const header =
      '# Import receipt written by the DevCatToolRegistry import tool.\n' +
      '# Do not hand-edit: it drives uninstall and reference counting.\n';
    const target = this.pathFor(receipt.toolId);
    // `lineWidth: 0` disables folding so long paths stay on one line.
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
    for (const name of entries.filter((n) => n.endsWith('.utool')).sort()) {
      const file = path.join(this.dir, name);
      try {
        const doc = loadUtool(file);
        checkHeader(doc, file, KIND.RECEIPT);
        receipts.push(doc);
      } catch (cause) {
        throw new DocumentError(
          'E-RECEIPT-INVALID',
          `receipt ${name} is unreadable and must be repaired or removed: ${cause.message}`,
        );
      }
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
    const doc = loadUtool(file);
    checkHeader(doc, file, KIND.RECEIPT);
    return doc;
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
    const normalized = relativeFile.replace(/\\/g, '/');
    const receipts = await this.list();
    return receipts
      .filter((receipt) =>
        (receipt.installedFiles ?? []).some((f) => f.replace(/\\/g, '/') === normalized),
      )
      .map((receipt) => receipt.toolId)
      .sort();
  }

  /**
   * Plan an uninstall.
   *
   * Files are shared when more than one receipt claims them, so they survive
   * until the last claimant leaves. Everything is reported before it is touched;
   * this function does not delete anything.
   *
   * @param {string[]} toolIds
   * @returns {Promise<{delete: string[], keep: {file: string, claimedBy: string[]}[], missingReceipts: string[]}>}
   */
  async planUninstall(toolIds) {
    const all = await this.list();
    const going = new Set(toolIds);
    const staying = all.filter((receipt) => !going.has(receipt.toolId));

    const missingReceipts = toolIds.filter((id) => !all.some((r) => r.toolId === id));

    /** @type {Map<string, string[]>} */
    const survivors = new Map();
    for (const receipt of staying) {
      for (const file of receipt.installedFiles ?? []) {
        const normalized = file.replace(/\\/g, '/');
        if (!survivors.has(normalized)) survivors.set(normalized, []);
        survivors.get(normalized).push(receipt.toolId);
      }
    }

    const toDelete = [];
    const toKeep = [];
    for (const receipt of all.filter((r) => going.has(r.toolId))) {
      for (const file of receipt.installedFiles ?? []) {
        const normalized = file.replace(/\\/g, '/');
        const claimedBy = survivors.get(normalized);
        if (claimedBy && claimedBy.length > 0) {
          toKeep.push({ file: normalized, claimedBy: [...claimedBy].sort() });
        } else if (!toDelete.includes(normalized)) {
          toDelete.push(normalized);
        }
      }
    }

    toDelete.sort();
    return { delete: toDelete, keep: toKeep, missingReceipts };
  }
}

export { EXIT };
