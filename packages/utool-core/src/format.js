/**
 * Closed vocabulary of the .yaml format, formatVersion 2.
 *
 * The manifest is split in two halves and this file mirrors that split:
 *
 *   ENGINE-NEUTRAL  identity, capabilities, dependency edges. These mean the same
 *                   thing whatever consumes the payload.
 *   ENGINE-SPECIFIC requirements and artifacts, which live under `targets` and
 *                   whose vocabulary belongs to that engine's adapter.
 *
 * Nothing engine-specific is enumerated here. `unitypackage` in particular is NOT
 * a core format: it is registered by the Unity adapter like any other engine
 * container. The core knows only general archives plus the artifact *kinds*.
 */

export const FORMAT_VERSION = '2';

/** Document discriminators. A reader must reject a `kind` it does not know. */
export const KIND = Object.freeze({
  TOOL: 'tool',
  INDEX: 'index',
  RECEIPT: 'receipt',
});

export const KNOWN_KINDS = Object.freeze([KIND.TOOL, KIND.INDEX, KIND.RECEIPT]);

/** Fixed file names. A payload is identified by its manifest file name. */
export const FILE_NAMES = Object.freeze({
  MANIFEST: 'tool.yaml',
  /** Accepted alias: the contents are YAML, so a tool.yaml manifest is not a lie. */
  MANIFEST_ALIAS: 'tool.yaml',
  INDEX: 'index.yaml',
  INDEX_ALIAS: 'index.yaml',
  receiptFor: (toolId) => `${toolId}.yaml`,
});

/** Entries a payload directory is allowed to contain, and nothing else. */
export const ALLOWED_PAYLOAD_ENTRIES = Object.freeze([
  FILE_NAMES.MANIFEST,
  FILE_NAMES.MANIFEST_ALIAS,
  'README.md',
  'artifacts',
]);

/** Engine-neutral tool kinds. Engine-specific kinds (shader packs) are not here. */
export const TOOL_TYPES = Object.freeze([
  'editor-tool',
  'tool-library',
  'framework',
  'asset-pack',
  'template',
]);

/**
 * Artifact kinds, which the CORE understands:
 *
 *   archive   a general container the core itself opens (see CORE_ARCHIVE_FORMATS)
 *   package   an engine-specific container; only that engine's adapter opens it
 *   file      a single-file payload with no container at all (dll, shader, txt)
 *   external  nothing is stored here; the payload lives in another repository
 */
export const ARTIFACT_TYPE = Object.freeze({
  ARCHIVE: 'archive',
  PACKAGE: 'package',
  FILE: 'file',
  EXTERNAL: 'external',
});

export const KNOWN_ARTIFACT_TYPES = Object.freeze(Object.values(ARTIFACT_TYPE));

/**
 * General archive formats the core opens with node:zlib alone.
 *
 * Deliberately excludes xz/lzma: Node has no built-in lzma codec, and adding a
 * dependency for a format that is rare in package distribution is not worth it.
 * An engine that needs it can register it through its adapter.
 */
export const CORE_ARCHIVE_FORMATS = Object.freeze(['zip', 'tgz', 'tar.gz', 'tar.zst']);

export const ARCHIVE_MAGIC = Object.freeze({
  'zip': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  'tgz': Buffer.from([0x1f, 0x8b]),
  'tar.gz': Buffer.from([0x1f, 0x8b]),
  'tar.zst': Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
});

/** Container format -> file extension used in artifact names. */
export const FORMAT_EXTENSION = Object.freeze({
  'zip': 'zip',
  'tgz': 'tgz',
  'tar.gz': 'tgz',
  'tar.zst': 'tar.zst',
});

export const UNPACK = Object.freeze({ AUTO: 'auto', NONE: 'none' });

/** Where receipts live inside a consumer project. Library/ is never committed. */
export const RECEIPT_DIR = 'Library/DevCatToolRegistry/receipts';

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ENGINE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CAPABILITY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
export const STRICT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$/;
export const CONSTRAINT_PATTERN = /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const PACKAGE_NAME_PATTERN = /^[a-z0-9]+(\.[a-z0-9\-]+)+$/;

/** payloads/<id>/artifacts/<file> - the directory part only. */
export const ARTIFACT_PATH_PARTS_PATTERN = /^payloads\/([a-z0-9-]+)\/artifacts\/([^/]+)$/;

/**
 * The mandated artifact file name: <id>-<version>[-<engine>].<ext>.
 *
 * Exported for documentation and for the validator's looser pre-check, but note
 * that `artifactNameEngine` does NOT use its groups. A regular expression cannot
 * split this name reliably: the id may end in a digit, so for
 * `core-editor-utils-1.1.0-unity.unitypackage` the engine group is optional and
 * the id group can absorb the leading `1`, making the engine come back null. The
 * deterministic check below is used instead.
 */
export const ARTIFACT_NAME_PATTERN = new RegExp(
  '^([a-z0-9-]+)-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.\\-]+)?)' +
    '(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\\.([a-z0-9]+(?:\\.[a-z0-9]+)*)$',
);

/**
 * Split an artifact file name into its parts, deterministically.
 *
 * Works from BOTH ends inwards rather than with one regular expression, because a
 * single regex cannot do this reliably in either direction:
 *
 *   - scanning forward, the id may end in a digit, so `core-editor-utils-1.1.0`
 *     lets the id group absorb the leading `1` and the engine segment disappears
 *     (it is optional, so the engine comes back null);
 *   - scanning for the version, a prerelease suffix is greedy and
 *     `1.1.0-unity` looks exactly like a valid `1.1.0-unity` prerelease.
 *
 * So: the extension is everything after the last dot; then a trailing segment is
 * an engine only when what remains still ends in a version triple. Whatever is
 * left is the id.
 *
 * @param {string} name file name only, no directory
 * @returns {{ok: boolean, id?: string, version?: string, engine?: string|null, extension?: string, reason?: string}}
 */
export function splitArtifactName(name) {
  // Known extensions first, longest first, so a compound one such as `.tar.zst`
  // is not mistaken for a `.zst` file whose version ends in `.tar`.
  const known = [...new Set(Object.values(FORMAT_EXTENSION))].sort((a, b) => b.length - a.length);
  const knownMatch = known.find((extension) => name.endsWith(`.${extension}`));

  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return { ok: false, reason: `no extension in '${name}'` };
  }

  let stem;
  let extension;
  if (knownMatch) {
    extension = knownMatch;
    stem = name.slice(0, name.length - knownMatch.length - 1);
  } else {
    extension = name.slice(lastDot + 1);
    stem = name.slice(0, lastDot);
  }

  // Peel off a trailing segment when the remainder still ends in a version.
  // `-1.1.0-unity` -> stem `-1.1.0`, engine `unity`;  `-1.1.0` -> stays put.
  let engine = null;
  const stemDot = stem.lastIndexOf('.');
  if (stemDot !== -1) {
    const tail = stem.slice(stemDot + 1);
    const dash = tail.indexOf('-');
    if (dash > 0) {
      const candidateStem = stem.slice(0, stemDot + 1 + dash);
      if (VERSION_TRIPLE_AT_END.test(candidateStem)) {
        engine = tail.slice(dash + 1);
        stem = candidateStem;
      }
    }
  }

  const versionMatch = VERSION_AT_END.exec(stem);
  if (!versionMatch) {
    return { ok: false, reason: `no version triple at the end of '${name}'` };
  }
  const version = versionMatch[1];
  const id = stem.slice(0, stem.length - versionMatch[0].length);

  if (!id) return { ok: false, reason: `no id before the version in '${name}'` };
  if (engine !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(engine)) {
    return { ok: false, reason: `engine segment '${engine}' is not lowercase kebab-case` };
  }

  return { ok: true, id, version, engine, extension };
}

/** A version triple anchored at the end of a string. */
const VERSION_AT_END = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)$/;

/** A version triple anchored at the end, without capturing. */
const VERSION_TRIPLE_AT_END = /-\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$/;

/** @returns {string|null} the engine segment of an artifact name, if present */
export function artifactNameEngine(name) {
  const parts = splitArtifactName(String(name));
  return parts.ok ? parts.engine : null;
}
/**
 * Is a capability name well formed? Two segments minimum, so a capability always
 * states its namespace rather than being a bare word.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isCapability(name) {
  return typeof name === 'string' && CAPABILITY_PATTERN.test(name);
}

/**
 * Expected artifact file name for one target.
 *
 * @param {string} toolId
 * @param {string} version
 * @param {string} engine
 * @param {boolean} multiEngine one manifest with several targets adds the engine
 *   segment, so two engines' artifacts can share a directory
 * @param {string} format
 * @returns {string}
 */
export function expectedArtifactName(toolId, version, engine, multiEngine, format) {
  const extension = FORMAT_EXTENSION[format] ?? format;
  const engineSegment = multiEngine ? `-${engine}` : '';
  return `${toolId}-${version}${engineSegment}.${extension}`;
}
