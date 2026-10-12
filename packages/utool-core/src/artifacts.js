/**
 * Artifact verification.
 *
 * Nothing is written to a project until every artifact in the plan passes all of
 * these checks, in this order (docs/FRONTEND-INTEGRATION.zh-CN.md section 6.2):
 *
 *   1. byte length matches the declared size
 *   2. sha256 matches the declared digest
 *   3. the container magic matches the declared format
 *   4. the archive holds no absolute or `..` entries (tar-slip / zip-slip)
 *   5. a .unitypackage contains `pathname` entries, or Unity cannot place files
 *
 * A failure throws ArtifactError; a successful check returns a report.
 */

import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { ArtifactError } from './errors.js';
import { ARTIFACT_FORMAT, MAGIC } from './format.js';

/**
 * @typedef {Object} ArtifactReport
 * @property {string} path repository-relative path
 * @property {number} size actual byte length
 * @property {string} sha256 actual digest
 * @property {string} format verified container format
 * @property {number} entries entry count
 * @property {string[]} files project-relative paths the package will install
 */

/**
 * Compute a streamed sha256 so a large artifact does not have to be held in RAM.
 *
 * @param {string} filePath
 * @returns {Promise<{size: number, sha256: string}>}
 */
export async function hashFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    let size = 0;
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** @returns {boolean} */
function startsWith(buffer, magic) {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

/**
 * Detect the container format from the file's first bytes.
 *
 * @param {Buffer} head
 * @returns {'unitypackage'|'zip'|null}
 */
export function detectFormat(head) {
  if (startsWith(head, MAGIC.gzip)) return ARTIFACT_FORMAT.UNITYPACKAGE;
  if (startsWith(head, MAGIC.zip)) return ARTIFACT_FORMAT.ZIP;
  return null;
}

/**
 * Parse the entry names of a gzipped tar without writing anything to disk.
 * Minimal tar reader: enough to enumerate names, which is all the safety and
 * structure checks need.
 *
 * @param {Buffer} gzBytes
 * @returns {string[]} entry names in archive order
 */
export function listTarEntries(gzBytes) {
  let raw;
  try {
    raw = gunzipSync(gzBytes);
  } catch (cause) {
    throw new ArtifactError('E-ARTIFACT-GZIP', `not readable as gzip: ${cause.message}`);
  }

  const names = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (Number.isNaN(size)) {
      throw new ArtifactError('E-ARTIFACT-TAR', 'malformed tar header (unreadable size field)');
    }

    const fullName = prefix ? `${prefix}/${name}` : name;
    names.push(fullName);

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  if (names.length === 0) {
    throw new ArtifactError('E-ARTIFACT-EMPTY', 'archive contains no entries');
  }
  return names;
}

function readNullTerminated(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/**
 * Read entry names from a zip central directory.
 *
 * @param {Buffer} zipBytes
 * @returns {string[]}
 */
export function listZipEntries(zipBytes) {
  // Locate the end-of-central-directory record, scanning back over the
  // optional comment (max 65535 bytes).
  const minOffset = Math.max(0, zipBytes.length - 65_557);
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= minOffset; i -= 1) {
    if (zipBytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new ArtifactError('E-ARTIFACT-ZIP', 'no end-of-central-directory record found');
  }

  const entryCount = zipBytes.readUInt16LE(eocd + 10);
  let offset = zipBytes.readUInt32LE(eocd + 16);
  const names = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > zipBytes.length || zipBytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new ArtifactError('E-ARTIFACT-ZIP', 'malformed zip central directory');
    }
    const nameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (names.length === 0) {
    throw new ArtifactError('E-ARTIFACT-EMPTY', 'archive contains no entries');
  }
  return names;
}

/** @returns {boolean} true when an entry name is safe to extract */
export function isSafeEntry(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false; // Windows drive letter
  return !normalized.split('/').includes('..');
}

/**
 * Verify bytes against the manifest's declared artifact.
 *
 * @param {Buffer} bytes
 * @param {{path: string, size: number, sha256: string, format: string}} declared
 * @param {string} [sourceLabel]
 * @returns {ArtifactReport}
 */
export function verifyArtifactBytes(bytes, declared, sourceLabel = declared.path) {
  if (bytes.length !== declared.size) {
    throw new ArtifactError(
      'E-ARTIFACT-SIZE',
      `${sourceLabel}: declared size ${declared.size} != actual ${bytes.length}`,
      { declared: declared.size, actual: bytes.length },
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== declared.sha256) {
    throw new ArtifactError(
      'E-ARTIFACT-HASH',
      `${sourceLabel}: declared sha256 ${declared.sha256} != actual ${sha256}`,
      { declared: declared.sha256, actual: sha256 },
    );
  }

  const detected = detectFormat(bytes);
  if (detected === null) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT',
      `${sourceLabel}: bytes are neither a gzip tar nor a zip; cannot honour format '${declared.format}'`,
    );
  }
  if (detected !== declared.format) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT',
      `${sourceLabel}: declared format '${declared.format}' but the container is '${detected}'`,
    );
  }

  const entries =
    detected === ARTIFACT_FORMAT.UNITYPACKAGE ? listTarEntries(bytes) : listZipEntries(bytes);

  const unsafe = entries.filter((name) => !isSafeEntry(name));
  if (unsafe.length > 0) {
    throw new ArtifactError(
      'E-ARTIFACT-UNSAFE',
      `${sourceLabel}: archive holds unsafe entries: ${unsafe.slice(0, 3).join(', ')}`,
      { entries: unsafe.slice(0, 10) },
    );
  }

  let files = [];
  if (detected === ARTIFACT_FORMAT.UNITYPACKAGE) {
    const inspected = inspectUnitypackage(bytes);
    files = inspected.files;
    if (inspected.pathnameCount === 0) {
      throw new ArtifactError(
        'E-ARTIFACT-PATHNAME',
        `${sourceLabel}: no pathname entries found, so Unity cannot place the files`,
      );
    }
    // Entry NAMES were checked above; a pathname's *value* is a destination and
    // must be checked too, or a package could write outside the project root.
    const escaping = files.filter((file) => !isSafeEntry(file) && !file.startsWith('<unresolved:'));
    if (escaping.length > 0) {
      throw new ArtifactError(
        'E-ARTIFACT-UNSAFE',
        `${sourceLabel}: pathname destinations escape the project root: ${escaping.slice(0, 3).join(', ')}`,
        { pathnames: escaping.slice(0, 10) },
      );
    }
    if (files.some((file) => file.startsWith('<unresolved:'))) {
      throw new ArtifactError(
        'E-ARTIFACT-PATHNAME',
        `${sourceLabel}: a GUID folder has an empty pathname, so its destination is undefined`,
      );
    }
  }

  return { path: declared.path, size: bytes.length, sha256, format: detected, entries: entries.length, files };
}

/**
 * Read the `.unitypackage` GUID folders into project-relative file paths.
 *
 * A .unitypackage is a gzipped tar of `<guid>/asset`, `<guid>/asset.meta` and
 * `<guid>/pathname`. The pathname holds the destination, relative to the project
 * root (so it starts with `Assets/` for anything that lands in the project).
 *
 * @param {Buffer} gzBytes
 * @returns {{files: string[], pathnameCount: number, folderCount: number}}
 *   `files` excludes directory entries (a GUID folder with no asset bytes);
 *   `pathnameCount` counts every pathname seen, so a caller can tell "this
 *   package declares no destinations at all" from "this package only creates
 *   empty folders".
 */
export function inspectUnitypackage(gzBytes) {
  const raw = gunzipSync(gzBytes);
  /** @type {Map<string, {pathname: string, assetSize: number}>} */
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

    const slash = fullName.lastIndexOf('/');
    if (slash > 0) {
      const guid = fullName.slice(0, slash);
      const leaf = fullName.slice(slash + 1);
      if (!folders.has(guid)) folders.set(guid, { pathname: '', assetSize: 0 });
      const folder = folders.get(guid);
      if (leaf === 'pathname') {
        folder.pathname = raw
          .subarray(offset + 512, offset + 512 + size)
          .toString('utf8')
          .replace(/\0+$/, '')
          .trim();
      } else if (leaf === 'asset') {
        folder.assetSize = size;
      }
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  const files = [];
  let pathnameCount = 0;
  for (const [guid, folder] of folders) {
    if (folder.pathname) pathnameCount += 1;
    // A GUID folder with no asset bytes is a directory entry: it has a pathname
    // but nothing to write, so it is not a file this package installs.
    if (folder.assetSize === 0) continue;
    if (folder.pathname) files.push(folder.pathname);
    else files.push(`<unresolved:${guid}>`);
  }

  return { files: files.sort(), pathnameCount, folderCount: folders.size };
}

/**
 * Convenience wrapper returning only the destination paths.
 *
 * @param {Buffer} gzBytes
 * @returns {string[]}
 */
export function readUnitypackagePathnames(gzBytes) {
  return inspectUnitypackage(gzBytes).files;
}

/**
 * Verify an artifact on disk against a manifest's declaration.
 *
 * @param {string} filePath
 * @param {{path: string, size: number, sha256: string, format: string}} declared
 * @returns {Promise<ArtifactReport>}
 */
export async function verifyArtifactFile(filePath, declared) {
  const bytes = await readFile(filePath);
  return verifyArtifactBytes(bytes, declared, path.relative(process.cwd(), filePath));
}

export { ARTIFACT_FORMAT };
