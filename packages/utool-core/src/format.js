/**
 * Closed vocabulary of the .utool format.
 *
 * Everything the format fixes lives here so the parser, the validator and the
 * CLI cannot drift apart. If a value is not in this file, a .utool document
 * containing it is rejected rather than guessed at.
 */

export const FORMAT_VERSION = '1';

/** Document discriminators. A reader must reject a `kind` it does not know. */
export const KIND = Object.freeze({
  TOOL: 'tool',
  INDEX: 'index',
  RECEIPT: 'receipt',
});

export const KNOWN_KINDS = Object.freeze([KIND.TOOL, KIND.INDEX, KIND.RECEIPT]);

/** Fixed file names. A payload is identified by its manifest file name. */
export const FILE_NAMES = Object.freeze({
  MANIFEST: 'tool.utool',
  INDEX: 'index.utool',
  // one receipt per installed tool, written by the import tool
  receiptFor: (toolId) => `${toolId}.utool`,
});

/** Entries a payload directory is allowed to contain, and nothing else. */
export const ALLOWED_PAYLOAD_ENTRIES = Object.freeze([
  FILE_NAMES.MANIFEST,
  'README.md',
  'artifacts',
]);

export const TOOL_TYPES = Object.freeze([
  'editor-tool',
  'tool-library',
  'framework',
  'asset-pack',
  'shader-pack',
  'template',
]);

export const SOURCE_KIND = Object.freeze({
  BUNDLED: 'bundled',
  EXTERNAL: 'external',
});

export const SOURCE_TYPE = Object.freeze({
  ARCHIVE: 'archive',
  GIT: 'git',
});

export const ARTIFACT_FORMAT = Object.freeze({
  UNITYPACKAGE: 'unitypackage',
  ZIP: 'zip',
});

export const KNOWN_ARTIFACT_FORMATS = Object.freeze([
  ARTIFACT_FORMAT.UNITYPACKAGE,
  ARTIFACT_FORMAT.ZIP,
]);

/** Container magic bytes, so a mislabelled artifact cannot slip through. */
export const MAGIC = Object.freeze({
  gzip: Buffer.from([0x1f, 0x8b]),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
});

/** Where receipts live inside a consumer project. Library/ is never committed. */
export const RECEIPT_DIR = 'Library/UnityDevCommonLib/receipts';

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const STRICT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$/;
export const CONSTRAINT_PATTERN = /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$/;
export const UNITY_VERSION_PATTERN = /^\d{4}\.\d+(\.\d+[abfp]\d+)?$/;
export const DOTNET_VERSION_PATTERN = /^\d+\.\d+$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const PACKAGE_NAME_PATTERN = /^[a-z0-9]+(\.[a-z0-9\-]+)+$/;
/**
 * Artifact paths must be payloads/<id>/artifacts/<id>-<version>.<ext>.
 *
 * A version contains dots (`1.1.0`), so the file name cannot be matched by a
 * single character class: it must be `<id>-<version>` followed by the extension,
 * with the extension dot being the FIRST dot in the name. Matching `.` inside the
 * name class instead is a trap -- the regex would happily treat a version
 * separator as the extension separator and accept a name with no extension.
 *
 * The capture group is therefore the name WITHOUT its extension; the extension is
 * captured separately for the caller's convenience.
 */
export const ARTIFACT_FORMAT_PATTERN = /\.(unitypackage|zip)$/;

/**
 * The directory part of an artifact path: payloads/<id>/artifacts/<file>.
 *
 * Split out because a single regex cannot express "the name is <id>-<version>
 * plus extension" without the version's own dots confusing the extension match.
 * Callers pair this with isConformingArtifactName() and an exact name comparison.
 */
export const ARTIFACT_PATH_PARTS_PATTERN = /^payloads\/([a-z0-9-]+)\/artifacts\/([^/]+)$/;

/** Does a payload name follow <id>-<version>.<ext>, with the extension dot last?
 *
 * @param {string} name file name only, no directory
 * @returns {boolean}
 */
export function isConformingArtifactName(name) {
  return /^[A-Za-z0-9_-]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.(unitypackage|zip)$/.test(name);
}