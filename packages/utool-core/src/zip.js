/**
 * Minimal ZIP reader built on node:zlib.
 *
 * The backend needs two things from a zip: the entry list (for safety checks)
 * and the decompressed contents of each entry. Both are available from the
 * central directory plus raw deflate, so this avoids a dependency on a zip
 * library -- which matters because the core is meant to be embeddable in a
 * consumer's toolchain with a very small footprint.
 *
 * Supports the stored (0) and deflate (8) methods, which is what every ordinary
 * archiver emits. Anything else is rejected explicitly rather than guessed at.
 */

import { inflateRawSync } from 'node:zlib';

import { ArtifactError } from './errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * @typedef {Object} ZipEntry
 * @property {string} name
 * @property {number} method
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} localHeaderOffset
 * @property {boolean} isDirectory
 */

/**
 * Read the central directory.
 *
 * @param {Buffer} bytes
 * @returns {ZipEntry[]}
 */
export function readCentralDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ArtifactError('E-ARTIFACT-ZIP', 'malformed zip central directory');
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes) {
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ArtifactError('E-ARTIFACT-ZIP', 'no end-of-central-directory record found');
}

/**
 * Decompress one entry.
 *
 * @param {Buffer} bytes whole archive
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
export function readEntry(bytes, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ArtifactError('E-ARTIFACT-ZIP', `bad local header for '${entry.name}'`);
  }
  // The local header's name/extra lengths can differ from the central record,
  // so the payload offset must be computed from the local header.
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  switch (entry.method) {
    case METHOD_STORED:
      return Buffer.from(data);
    case METHOD_DEFLATE:
      return inflateRawSync(data);
    default:
      throw new ArtifactError(
        'E-ARTIFACT-ZIP-METHOD',
        `'${entry.name}' uses compression method ${entry.method}; only stored and deflate are supported`,
      );
  }
}

/**
 * Decompress every file entry, skipping directory records.
 *
 * @param {Buffer} bytes
 * @returns {{name: string, data: Buffer}[]}
 */
export function readAllEntries(bytes) {
  const entries = readCentralDirectory(bytes).filter((entry) => !entry.isDirectory);
  return entries.map((entry) => ({ name: entry.name, data: readEntry(bytes, entry) }));
}

export { METHOD_STORED, METHOD_DEFLATE };
