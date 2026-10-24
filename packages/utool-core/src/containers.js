/**
 * Container handlers and the registry adapters plug them into.
 *
 * The core does not know what a `.unitypackage` is. It knows how to read general
 * archives, and it exposes a registry that an engine adapter fills with the
 * formats it owns. That is the whole engine-decoupling mechanism on the artifact
 * side:
 *
 *   core      zip, tgz, tar.gz, tar.zst, and single-file payloads
 *   provider  everything else, registered by name, so the core never grows an
 *             `if (engine === 'unity')`
 *
 * A handler reports what a container holds without writing anything, and lists
 * what it would extract. `planInstallation` uses the first, `executeInstall` the
 * second, so verification and extraction cannot disagree about the file list.
 */

import { ArtifactError } from './errors.js';
import {
  ARCHIVE_MAGIC,
  ARTIFACT_TYPE,
  CORE_ARCHIVE_FORMATS,
  UNPACK,
} from './format.js';

/**
 * @typedef {Object} ContainerItem
 * @property {string} path destination, relative to the project root (or to
 *   contentRoot, which the caller applies later)
 * @property {number} size
 * @property {boolean} [directory] true for a directory record with no bytes
 */

/**
 * @typedef {Object} InspectResult
 * @property {ContainerItem[]} items what would be installed
 * @property {number} entries raw entry count, for diagnostics
 */

/**
 * A container handler.
 *
 * @typedef {Object} ContainerHandler
 * @property {string} id stable handler id, e.g. "core:zip" or "unity:unitypackage"
 * @property {string[]} formats container format names it owns
 * @property {(bytes: Buffer, artifact: object, context: object) => InspectResult} inspect
 *   report destinations without writing
 * @property {(bytes: Buffer, artifact: object, context: object) => Promise<ContainerItem[]>} extract
 *   write the payload and return the destinations actually written
 */

export class ContainerRegistry {
  constructor() {
    /** @type {Map<string, ContainerHandler>} */
    this.byFormat = new Map();
  }

  /**
   * @param {ContainerHandler} handler
   * @returns {this}
   */
  register(handler) {
    for (const format of handler.formats) {
      const existing = this.byFormat.get(format);
      if (existing && existing.id !== handler.id) {
        throw new Error(
          `container format '${format}' is already registered by '${existing.id}'; ` +
            `'${handler.id}' cannot take it over`,
        );
      }
      this.byFormat.set(format, handler);
    }
    return this;
  }

  /** @returns {ContainerHandler|null} */
  for(format) {
    return this.byFormat.get(format) ?? null;
  }

  /** @returns {boolean} */
  handles(format) {
    return this.byFormat.has(format);
  }

  /** @returns {string[]} every format currently registered, sorted */
  formats() {
    return [...this.byFormat.keys()].sort();
  }

  /**
   * Which handler should deal with this artifact?
   *
   * @param {object} artifact
   * @returns {ContainerHandler|null}
   */
  resolve(artifact) {
    if (artifact.type === ARTIFACT_TYPE.FILE) return null;
    if (artifact.unpack === UNPACK.NONE) return null;
    return this.for(String(artifact.format));
  }
}

/**
 * Handler for a single-file payload: no container, nothing to open.
 *
 * The file is copied to artifact.targetPath. This is what makes a bare dll a
 * first-class payload: it travels the same verification, planning, extraction and
 * receipt path as an archive, so a "file" install is exactly as removable.
 */
export const fileHandler = {
  id: 'core:file',
  formats: [],
  /** @returns {InspectResult} */
  inspect(_bytes, artifact) {
    if (!artifact.targetPath) {
      throw new ArtifactError(
        'E-ARTIFACT-TARGETPATH',
        `artifact type file requires targetPath, otherwise its destination is undefined`,
      );
    }
    return {
      items: [{ path: artifact.targetPath, size: artifact.size ?? 0 }],
      entries: 1,
    };
  },
  /** @returns {Promise<ContainerItem[]>} */
  async extract(bytes, artifact, context) {
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const destination = path.join(context.projectRoot, artifact.targetPath);
    await context.ensureDirectory(path.dirname(destination));
    await writeFile(destination, bytes);
    return [{ path: artifact.targetPath.replace(/\\/g, '/'), size: bytes.length }];
  },
};

/**
 * Build the core container registry: the general archives plus single files.
 *
 * Engine formats are deliberately absent. A caller that needs Unity payloads must
 * register the Unity adapter, and a caller that only handles zip/tgz needs nothing
 * else - which is what makes the core usable from a non-engine tool.
 *
 * @returns {ContainerRegistry}
 */
export function createCoreContainerRegistry() {
  const registry = new ContainerRegistry();
  registry.register(fileHandler);
  for (const format of CORE_ARCHIVE_FORMATS) {
    registry.register(createArchiveHandler(format));
  }
  return registry;
}

/**
 * Handler for one general archive format.
 *
 * @param {string} format
 * @returns {ContainerHandler}
 */
function createArchiveHandler(format) {
  return {
    id: `core:${format}`,
    formats: [format],
    inspect(bytes, artifact) {
      const { items, entries } = readArchive(bytes, format, artifact);
      return { items, entries };
    },
    async extract(bytes, artifact, context) {
      const { items } = readArchive(bytes, format, artifact);
      const written = [];
      for (const item of items) {
        if (item.directory) {
          await context.ensureDirectory(context.resolve(item.path));
          continue;
        }
        await context.writeItem(item);
        // Report the PROJECT-RELATIVE destination, not the archive-relative one. A
        // receipt has to name where a file actually is, or uninstall looks for it in
        // the wrong place. When a contentRoot is set the two differ, which is exactly
        // the case that previously went wrong.
        written.push({ path: context.relative(item.path), size: item.size });
      }
      return written;
    },
  };
}

/**
 * Do these bytes begin with this magic?
 *
 * Numeric comparison rather than Buffer.equals, because ARCHIVE_MAGIC holds plain arrays so this
 * module stays free of Node-only globals and can be embedded in a browser page.
 */
function hasMagic(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Read an archive's entries and map them to destinations.
 *
 * Shared by inspect and extract so the two can never disagree.
 *
 * @param {Buffer} bytes
 * @param {string} format
 * @param {object} artifact
 * @returns {{items: ContainerItem[], entries: number}}
 */
function readArchive(bytes, format, artifact) {
  const magic = ARCHIVE_MAGIC[format];
  if (magic && !hasMagic(bytes, magic)) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT',
      `declared format '${format}' but the bytes do not carry that container's magic`,
    );
  }

  // Imported lazily so the module graph stays acyclic: archives.js needs the
  // registry, and this file needs the readers.
  const readers = format === 'zip' ? zipEntries(bytes) : tarEntries(bytes, format);
  const entries = readers.length;

  const prefix = normalisePrefix(artifact.subdirectory);
  const items = [];
  for (const entry of readers) {
    let name = entry.name.replace(/\\/g, '/');
    if (name.startsWith('./')) name = name.slice(2);

    if (prefix) {
      if (!name.startsWith(`${prefix}/`)) continue;
      name = name.slice(prefix.length + 1);
    }
    if (!name) continue;

    if (entry.directory) {
      items.push({ path: name.replace(/\/$/, ''), size: 0, directory: true });
      continue;
    }
    items.push({ path: name, size: entry.size, data: entry.data });
  }

  if (items.length === 0) {
    throw new ArtifactError(
      'E-ARTIFACT-EMPTY',
      prefix
        ? `archive holds no entries under the declared subdirectory '${prefix}'`
        : 'archive contains no entries',
    );
  }
  return { items, entries };
}

function normalisePrefix(subdirectory) {
  if (!subdirectory) return '';
  return String(subdirectory).replace(/^[/\\]+|[/\\]+$/g, '').replace(/\\/g, '/');
}

// --------------------------------------------------------------------------
// readers, kept here because they are core containers and nothing else uses them
// --------------------------------------------------------------------------

// A namespace import, not named imports.
//
// `import { zstdDecompressSync } from 'node:zlib'` is resolved when the module is LINKED, before
// any of this file's code runs: on a Node whose zlib has no such export the whole module fails to
// load, and the guard in decompressZstd never gets a chance to explain anything. The user sees
// "does not provide an export named 'zstdDecompressSync'" from inside node:zlib, which names
// neither this tool nor the version that would fix it.
import * as zlib from 'node:zlib';

/** The first Node release whose zlib exposes a zstd codec (v22.15.0). */
export const ZSTD_MIN_NODE = '22.15';

/** @returns {{name: string, size: number, data: Buffer|null, directory: boolean}[]} */
function tarEntries(bytes, format) {
  let raw;
  if (format === 'tar.zst') {
    raw = decompressZstd(bytes);
  } else {
    try {
      raw = zlib.gunzipSync(bytes);
    } catch (cause) {
      throw new ArtifactError('E-ARTIFACT-GZIP', `not readable as gzip: ${cause.message}`);
    }
  }
  return parseTar(raw);
}

/**
 * Decompress a zstd frame.
 *
 * Node has had a zstd codec since v22.15, so a real .tar.zst needs no dependency.
 * The shipped sample is a valid frame holding one uncompressed block, which this
 * also accepts; a raw block is read directly so a sample can be built without a
 * zstd library on the authoring side.
 */
function decompressZstd(bytes) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new ArtifactError(
      'E-ARTIFACT-CODEC',
      `this Node (${process.versions.node}) has no zstd codec; .tar.zst needs Node ${ZSTD_MIN_NODE} or newer`,
    );
  }
  // Try the real codec first: it handles both compressed and raw blocks.
  try {
    return zlib.zstdDecompressSync(bytes);
  } catch (cause) {
    throw new ArtifactError('E-ARTIFACT-ZSTD', `not readable as a zstd frame: ${cause.message}`);
  }
}

function parseTar(raw) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (Number.isNaN(size)) {
      throw new ArtifactError('E-ARTIFACT-TAR', 'malformed tar header (unreadable size field)');
    }
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const isDirectory = typeFlag === '5' || fullName.endsWith('/');
    const body = raw.subarray(offset + 512, offset + 512 + size);

    entries.push({
      name: fullName,
      size,
      data: isDirectory ? null : Buffer.from(body),
      directory: isDirectory,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readNullTerminated(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** @returns {{name: string, size: number, data: Buffer, directory: boolean}[]} */
function zipEntries(bytes) {
  const entries = readCentralDirectory(bytes);
  return entries.map((entry) => ({
    name: entry.name,
    size: entry.uncompressedSize,
    data: entry.isDirectory ? null : inflateEntry(bytes, entry),
    directory: entry.isDirectory,
  }));
}

function inflateEntry(bytes, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) {
    throw new ArtifactError('E-ARTIFACT-ZIP', `bad local header for '${entry.name}'`);
  }
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new ArtifactError(
    'E-ARTIFACT-ZIP-METHOD',
    `'${entry.name}' uses compression method ${entry.method}; only stored (0) and deflate (8) are supported`,
  );
}

function readCentralDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
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
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ArtifactError('E-ARTIFACT-ZIP', 'no end-of-central-directory record found');
}
