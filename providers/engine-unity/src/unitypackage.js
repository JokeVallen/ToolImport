/**
 * Unity container handler: `.unitypackage`.
 *
 * This is the file that makes `unitypackage` a Unity concept instead of a core
 * one. The core knows zip and tgz; it learns about Unity only because this handler
 * is registered. Delete this directory and the core still works for every other
 * engine, which is the property the split was for.
 *
 * A .unitypackage is a gzipped tar of one folder per asset:
 *
 *   <guid>/asset        the file's bytes (empty for a folder entry)
 *   <guid>/asset.meta   Unity's own import metadata
 *   <guid>/pathname     the DESTINATION, relative to the project root
 *
 * Two Unity-specific facts the core could not know:
 *
 *   1. The destination is inside `pathname`, not the tar entry name. The entry
 *      names are GUIDs and mean nothing on their own. So this handler reports
 *      pathname values as the items to install, and the core's safety check runs
 *      on those values - which is the check that matters, since a pathname can
 *      point outside the project.
 *   2. `asset.meta` is read but not written. Unity regenerates import metadata on
 *      import, and writing a stale .meta over an existing asset is worse than
 *      letting the editor create a fresh one. A GUID-stable .meta would matter for
 *      preserving references, which is a real limitation of this handler.
 */

import { gunzipSync } from 'node:zlib';

import { ArtifactError } from '@toolimport/utool-core';

const UNITYPACKAGE_FORMAT = 'unitypackage';

/**
 * Read a .unitypackage into GUID folders.
 *
 * @param {Buffer} bytes
 * @returns {Map<string, {pathname: string, asset: Buffer|null, meta: Buffer|null}>}
 */
function readFolders(bytes) {
  let raw;
  try {
    raw = gunzipSync(bytes);
  } catch (cause) {
    throw new ArtifactError(
      'E-ARTIFACT-GZIP',
      `not a readable .unitypackage (expected a gzipped tar): ${cause.message}`,
    );
  }

  /** @type {Map<string, {pathname: string, asset: Buffer|null, meta: Buffer|null}>} */
  const folders = new Map();
  let offset = 0;
  let sawAnyEntry = false;

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    sawAnyEntry = true;

    const name = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const sizeField = readNullTerminated(header, 124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (Number.isNaN(size)) {
      throw new ArtifactError('E-ARTIFACT-TAR', 'malformed tar header in .unitypackage');
    }

    const fullName = prefix ? `${prefix}/${name}` : name;
    const slash = fullName.lastIndexOf('/');
    if (slash > 0) {
      const guid = fullName.slice(0, slash);
      const leaf = fullName.slice(slash + 1);
      if (!folders.has(guid)) folders.set(guid, { pathname: '', asset: null, meta: null });
      const folder = folders.get(guid);
      const body = raw.subarray(offset + 512, offset + 512 + size);
      if (leaf === 'pathname') {
        folder.pathname = body.toString('utf8').replace(/\0+$/, '').trim();
      } else if (leaf === 'asset') {
        folder.asset = Buffer.from(body);
      } else if (leaf === 'asset.meta') {
        folder.meta = Buffer.from(body);
      }
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  if (!sawAnyEntry) {
    throw new ArtifactError('E-ARTIFACT-EMPTY', '.unitypackage contains no entries');
  }
  return folders;
}

function readNullTerminated(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/**
 * Folders that carry actual file bytes. A GUID folder with no asset is a folder
 * entry: it has a pathname but nothing to write, so it is not a file to install.
 */
function fileFolders(bytes) {
  const folders = readFolders(bytes);
  const entries = [];
  for (const [guid, folder] of folders) {
    if (!folder.pathname) {
      throw new ArtifactError(
        'E-ARTIFACT-PATHNAME',
        `GUID folder ${guid} has an empty pathname, so its destination is undefined`,
      );
    }
    if (folder.asset === null || folder.asset.length === 0) continue;
    entries.push({ guid, ...folder });
  }
  if (entries.length === 0) {
    throw new ArtifactError(
      'E-ARTIFACT-PATHNAME',
      '.unitypackage declares no file destinations; every GUID folder is empty',
    );
  }
  return entries;
}

export const unitypackageHandler = {
  id: 'unity:unitypackage',
  formats: [UNITYPACKAGE_FORMAT],

  /** @returns {{items: object[], entries: number}} */
  inspect(bytes) {
    const entries = fileFolders(bytes);
    return {
      items: entries.map((entry) => ({
        path: entry.pathname,
        size: entry.asset.length,
        data: entry.asset,
      })),
      entries: entries.length,
    };
  },

  /**
   * Write each asset to its pathname destination.
   *
   * @param {Buffer} bytes
   * @param {object} _artifact
   * @param {object} context the core's write context
   * @returns {Promise<object[]>} project-relative paths written
   */
  async extract(bytes, _artifact, context) {
    const entries = fileFolders(bytes);
    const written = [];
    for (const entry of entries) {
      const absolute = context.resolve(entry.pathname);
      const path = await import('node:path');
      await context.ensureDirectory(path.dirname(absolute));
      await context.writeItem({ path: entry.pathname, data: entry.asset });
      written.push({ path: context.relative(entry.pathname), size: entry.asset.length });
    }
    return written;
  },
};

export { UNITYPACKAGE_FORMAT };
