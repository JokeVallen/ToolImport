/**
 * .utool document loading and shape checking.
 *
 * The format is YAML contents behind a proprietary extension, discriminated by
 * `kind` and versioned by `formatVersion`. This module owns those two decisions
 * plus the plain-structure checks that must run before any semantic validation:
 *
 *   - exactly one YAML document, root must be a mapping
 *   - `kind` present and known, `formatVersion` present and implemented
 *
 * It does NOT enforce per-kind field rules; that is schema.js's job.
 */

import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

import { DocumentError, EXIT } from './errors.js';
import { FORMAT_VERSION, KNOWN_KINDS, KIND } from './format.js';

/**
 * Parse .utool text into its YAML value.
 *
 * @param {string} text file contents
 * @param {string} [source] used in error messages
 * @returns {Record<string, unknown>}
 */
export function parseUtool(text, source = '<memory>') {
  let doc;
  try {
    doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  } catch (cause) {
    throw new DocumentError('E-UTOOL-YAML', `${source}: not parseable as YAML: ${cause.message}`);
  }

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new DocumentError('E-UTOOL-YAML', `${source}: invalid YAML: ${first.message}`);
  }

  // A .utool file holds exactly one document. `---` separated files are
  // rejected rather than merged, so a stray separator cannot silently truncate.
  const value = doc.toJS({ maxAliasCount: 100 });

  if (value === null || value === undefined) {
    throw new DocumentError('E-UTOOL-EMPTY', `${source}: document is empty`);
  }
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new DocumentError(
      'E-UTOOL-ROOT',
      `${source}: document root must be a mapping, got ${Array.isArray(value) ? 'array' : typeof value}`,
    );
  }

  return value;
}

/**
 * Load and read a .utool file from disk.
 *
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function loadUtool(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new DocumentError('E-UTOOL-READ', `cannot read ${path}: ${cause.message}`);
  }
  // A BOM makes the first key parse as "\uFEFFkind" and vanish from lookups.
  // Catch it explicitly: it is the most common silent failure when saving YAML.
  if (text.charCodeAt(0) === 0xfeff) {
    throw new DocumentError('E-UTOOL-BOM', `${path}: file starts with a UTF-8 BOM; save as plain UTF-8`);
  }
  return parseUtool(text, path);
}

/**
 * Verify the discriminator and format revision of a loaded document.
 *
 * @param {Record<string, unknown>} doc
 * @param {string} source
 * @param {string} expectedKind one of KIND.*
 * @param {{lenient?: boolean}} [options] lenient demotes a mismatch to a return value
 * @returns {boolean} true when the header is acceptable
 */
export function checkHeader(doc, source, expectedKind, options = {}) {
  const { lenient = false } = options;
  const fail = (code, message) => {
    if (lenient) return false;
    throw new DocumentError(code, message);
  };

  const kind = doc.kind;
  if (kind === undefined || kind === null) {
    return fail('E-UTOOL-KIND-MISSING', `${source}: missing "kind" discriminator`);
  }
  if (!KNOWN_KINDS.includes(kind)) {
    return fail(
      'E-UTOOL-KIND-UNKNOWN',
      `${source}: unknown kind ${JSON.stringify(kind)}; this reader implements ${KNOWN_KINDS.join(', ')}`,
    );
  }
  if (kind !== expectedKind) {
    return fail(
      'E-UTOOL-KIND-MISMATCH',
      `${source}: expected kind ${expectedKind}, found ${JSON.stringify(kind)}`,
    );
  }

  const formatVersion = doc.formatVersion;
  if (formatVersion === undefined || formatVersion === null) {
    return fail('E-UTOOL-VERSION-MISSING', `${source}: missing "formatVersion"`);
  }
  // Compare as text: the format declares a string, and YAML would otherwise
  // turn a bare 1 into a number and slip past a strict string comparison.
  if (String(formatVersion) !== FORMAT_VERSION) {
    return fail(
      'E-UTOOL-VERSION-UNSUPPORTED',
      `${source}: formatVersion ${JSON.stringify(formatVersion)} is not supported ` +
        `(this tool implements "${FORMAT_VERSION}")`,
    );
  }

  return true;
}

/**
 * Load a document, check its header, and return it.
 *
 * @param {string} path
 * @param {string} expectedKind
 * @returns {Record<string, unknown>}
 */
export function loadKind(path, expectedKind) {
  const doc = loadUtool(path);
  checkHeader(doc, path, expectedKind);
  return doc;
}

export { KIND, FORMAT_VERSION, EXIT };
