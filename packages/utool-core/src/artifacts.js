/**
 * Artifact verification.
 *
 * Nothing is written to a project until every artifact in the plan passes all of
 * these, in order:
 *
 *   1. byte length matches the declared size
 *   2. sha256 matches the declared digest
 *   3. the container magic matches the declared format
 *   4. neither entry names nor reported destinations escape the target root
 *
 * The core verifies only what the core owns: general archives and single-file
 * payloads. An engine-specific container (a unitypackage, say) is inspected by
 * whatever handler its adapter registered, and the destinations that handler
 * reports are then checked here - a *destination* can escape the project root just
 * as an entry name can, so checking entry names alone would leave a hole.
 */

import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactError } from './errors.js';
import { ARCHIVE_MAGIC, ARTIFACT_TYPE, UNPACK } from './format.js';

/**
 * @typedef {Object} ArtifactReport
 * @property {string} path repository-relative path
 * @property {number} size actual byte length
 * @property {string} sha256 actual digest
 * @property {string|null} format verified container format, null for a single file
 * @property {import('./containers.js').ContainerItem[]} items what it would install
 * @property {number} entries raw entry count
 */

/**
 * Compute a streamed sha256 so a large artifact need not be held in RAM twice.
 *
 * @param {string} filePath
 * @returns {Promise<{size: number, sha256: string}>}
 */
export async function hashFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream()) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/**
 * Does `bytes` begin with `magic`?
 *
 * Compares numerically rather than via Buffer.equals, because ARCHIVE_MAGIC holds plain arrays so
 * the core stays usable in a browser. `bytes` is still a Buffer in Node.
 */
function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Which core container is this, if any?
 *
 * @param {Buffer} head first bytes
 * @returns {string|null} a core archive format name, or null
 */
export function detectCoreArchiveFormat(head) {
  for (const [format, magic] of Object.entries(ARCHIVE_MAGIC)) {
    if (startsWith(head, magic)) return format;
  }
  return null;
}

/**
 * Is an entry name or destination safe to write?
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeEntryName(name) {
  const normalised = String(name).replace(/\\/g, '/');
  if (normalised.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalised)) return false; // Windows drive letter
  return !normalised.split('/').some((segment) => segment === '..');
}

/**
 * @param {string[]} names
 * @param {string} label
 * @param {string} what "entries" or "destinations", for the message
 */
export function assertSafePaths(names, label, what) {
  const unsafe = names.filter((name) => !isSafeEntryName(name));
  if (unsafe.length > 0) {
    throw new ArtifactError(
      'E-ARTIFACT-UNSAFE',
      `${label}: ${what} escape the target root: ${unsafe.slice(0, 3).join(', ')}`,
      { unsafe: unsafe.slice(0, 10) },
    );
  }
}

/**
 * Where an artifact that is not unpacked lands.
 *
 * Only `targetPath` can answer this. The artifact's own `path` is REGISTRY-relative
 * (`payloads/<id>/artifacts/...`), which means nothing inside a project, so deriving a
 * destination from its basename would drop a stray file in the project root: inside the
 * project, recorded by a receipt, and belonging to nothing. A missing targetPath is
 * therefore refused rather than guessed.
 *
 * Shared with install.js on purpose. Planning and writing must agree about where the
 * bytes go, and the last time they computed a destination separately the receipt named a
 * path that did not exist.
 *
 * @param {{type?: string, format?: string, targetPath?: string}} declared
 * @param {string} [label]
 * @returns {string} project-relative destination
 */
export function placedArtifactDestination(declared, label = declared.path) {
  if (!declared.targetPath) {
    throw new ArtifactError(
      'E-ARTIFACT-TARGETPATH',
      `${label}: artifact type '${declared.type}' with unpack: none is placed as-is, so it needs ` +
        `targetPath to say where it lands. Set targetPath, or drop unpack: none to let the ` +
        `'${declared.format}' handler extract it instead.`,
    );
  }
  return declared.targetPath;
}

/**
 * Verify artifact bytes against a declared target, writing nothing.
 *
 * @param {Buffer} bytes
 * @param {object} declared {@link import('./manifest.js').ToolTarget#declaredArtifact}
 * @param {import('./containers.js').ContainerRegistry} registry
 * @param {string} [label]
 * @returns {ArtifactReport}
 */
export function verifyArtifactBytes(bytes, declared, registry, label = declared.path) {
  if (bytes.length !== declared.size) {
    throw new ArtifactError(
      'E-ARTIFACT-SIZE',
      `${label}: declared size ${declared.size} != actual ${bytes.length}`,
      { declared: declared.size, actual: bytes.length },
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== declared.sha256) {
    throw new ArtifactError(
      'E-ARTIFACT-HASH',
      `${label}: declared sha256 ${declared.sha256} != actual ${sha256}`,
      { declared: declared.sha256, actual: sha256 },
    );
  }

  // A single-file payload has no container to open. Handled here rather than
  // through a handler so this module stays free of a dependency on containers.js;
  // it is three lines of logic and the shape is fixed by the schema.
  if (declared.type === ARTIFACT_TYPE.FILE) {
    if (!declared.targetPath) {
      throw new ArtifactError(
        'E-ARTIFACT-TARGETPATH',
        `${label}: artifact type file requires targetPath, otherwise its destination is undefined`,
      );
    }
    assertSafePaths([declared.targetPath], label, 'destinations');
    const items = [{ path: declared.targetPath, size: bytes.length }];
    return { path: declared.path, size: bytes.length, sha256, format: null, items, entries: 1 };
  }

  // A container declared `unpack: none` is PLACED, not opened, so it needs no handler.
  //
  // This has to be decided before handler resolution. `resolve()` refuses an artifact
  // that is not being unpacked, so without this branch the report becomes "no handler is
  // registered for format 'unitypackage'" - while printing unitypackage among the
  // registered formats, because it is registered. The message then blames a missing
  // engine adapter for what is actually a missing (or unwanted) `unpack: none`.
  if (declared.unpack === UNPACK.NONE) {
    const destination = placedArtifactDestination(declared, label);
    assertSafePaths([destination], label, 'destinations');
    const items = [{ path: destination, size: bytes.length }];
    return {
      path: declared.path,
      size: bytes.length,
      sha256,
      format: declared.format ?? null,
      items,
      entries: 1,
    };
  }

  const handler = registry.resolve(declared);
  if (!handler) {
    throw new ArtifactError(
      'E-ARTIFACT-FORMAT-UNSUPPORTED',
      `${label}: no handler is registered for artifact type '${declared.type}' with format ` +
        `'${declared.format}'. Registered formats: ${registry.formats().join(', ') || '(none)'}. ` +
        `An engine-specific container needs that engine's adapter to be loaded.`,
    );
  }

  // If the handler owns a general archive format, the bytes must actually be it.
  const claimsCoreFormat = handler.formats.some((format) =>
    Object.prototype.hasOwnProperty.call(ARCHIVE_MAGIC, format),
  );
  if (claimsCoreFormat) {
    const detected = detectCoreArchiveFormat(bytes);
    if (!detected) {
      throw new ArtifactError(
        'E-ARTIFACT-FORMAT',
        `${label}: declared format '${declared.format}' but the bytes carry no known archive magic`,
      );
    }
  }

  const inspected = handler.inspect(bytes, declared, {});
  assertSafePaths(inspected.items.map((item) => item.path), label, 'destinations');

  return {
    path: declared.path,
    size: bytes.length,
    sha256,
    format: declared.format ?? null,
    items: inspected.items,
    entries: inspected.entries,
  };
}

/**
 * Verify an artifact on disk.
 *
 * @param {string} filePath
 * @param {object} declared
 * @param {import('./containers.js').ContainerRegistry} registry
 * @returns {Promise<ArtifactReport>}
 */
export async function verifyArtifactFile(filePath, declared, registry) {
  const bytes = await readFile(filePath);
  return verifyArtifactBytes(bytes, declared, registry, path.relative(process.cwd(), filePath));
}
