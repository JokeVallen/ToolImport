/**
 * Registry sources: where .utool documents and artifacts come from.
 *
 * The core never assumes the network. A source is anything that can hand back
 * the index, a manifest at a known path, and artifact bytes. That is what makes
 * the whole backend testable offline and lets the Unity front end point at a
 * sibling checkout during development.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ArtifactError, DocumentError } from './errors.js';
import { ALLOWED_PAYLOAD_ENTRIES, FILE_NAMES, KIND } from './format.js';
import { loadUtool, checkHeader, parseUtool } from './loader.js';

/** @typedef {{kind: 'local'|'http', describe: string}} SourceIdentity */

/**
 * A registry rooted at a local directory. Used for development, CI, and every
 * test in this package.
 */
export class LocalRegistrySource {
  /** @param {string} root absolute or relative directory holding index.utool */
  constructor(root) {
    this.root = path.resolve(root);
    this.kind = 'local';
    this.describe = this.root;
  }

  /** @returns {Promise<Record<string, unknown>>} */
  async fetchIndex() {
    const file = path.join(this.root, FILE_NAMES.INDEX);
    if (!existsSync(file)) {
      throw new DocumentError('E-INDEX-MISSING', `no ${FILE_NAMES.INDEX} under ${this.root}`);
    }
    const doc = loadUtool(file);
    checkHeader(doc, file, KIND.INDEX);
    return doc;
  }

  /**
   * @param {string} manifestPath repository-relative path from the index
   * @returns {Promise<Record<string, unknown>>}
   */
  async fetchManifest(manifestPath) {
    const file = path.join(this.root, manifestPath);
    if (!existsSync(file)) {
      throw new DocumentError('E-MANIFEST-MISSING', `${manifestPath} does not exist in ${this.describe}`);
    }
    const doc = loadUtool(file);
    checkHeader(doc, file, KIND.TOOL);
    return doc;
  }

  /**
   * @param {string} artifactPath repository-relative path
   * @returns {Promise<Buffer>}
   */
  async fetchArtifact(artifactPath) {
    const file = path.join(this.root, artifactPath);
    if (!existsSync(file)) {
      throw new ArtifactError('E-ARTIFACT-MISSING', `${artifactPath} does not exist in ${this.describe}`);
    }
    return readFile(file);
  }

  /**
   * Enumerate payload directories. Used by the registry validator, which must
   * see every payload rather than only the ones the index advertises.
   *
   * @returns {Promise<{id: string, dir: string, manifestPath: string}[]>}
   */
  async listPayloads() {
    const payloadsRoot = path.join(this.root, 'payloads');
    if (!existsSync(payloadsRoot)) {
      throw new DocumentError('E-LAYOUT', `missing payloads/ directory under ${this.root}`);
    }
    const entries = await readdir(payloadsRoot, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      found.push({
        id: entry.name,
        dir: path.join(payloadsRoot, entry.name),
        manifestPath: `payloads/${entry.name}/${FILE_NAMES.MANIFEST}`,
      });
    }
    found.sort((a, b) => a.id.localeCompare(b.id));
    return found;
  }

  /** @returns {Promise<string[]>} entries in a payload directory */
  async listPayloadEntries(id) {
    const dir = path.join(this.root, 'payloads', id);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    return entries.filter((name) => !ALLOWED_PAYLOAD_ENTRIES.includes(name));
  }

  /** Synchronous variant for hot paths that already know the file exists. */
  readUtoolSync(relativePath) {
    return loadUtool(path.join(this.root, relativePath));
  }

  readArtifactSync(relativePath) {
    return readFileSync(path.join(this.root, relativePath));
  }
}

/**
 * A registry served over HTTP, e.g. raw.githubusercontent.com.
 *
 * @example
 *   new HttpRegistrySource('https://raw.githubusercontent.com/owner/repo/main')
 */
export class HttpRegistrySource {
  /**
   * @param {string} baseUrl base URL with no trailing slash
   * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
   */
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.kind = 'http';
    this.describe = this.baseUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    /** @type {Map<string, Buffer>} */
    this.cache = new Map();
  }

  #url(relativePath) {
    return `${this.baseUrl}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
  }

  async #get(relativePath, { binary = false } = {}) {
    if (!this.fetchImpl) {
      throw new DocumentError('E-NO-FETCH', 'no fetch implementation available in this runtime');
    }
    const cacheKey = `${binary ? 'b:' : 't:'}${relativePath}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.#url(relativePath), { signal: controller.signal });
    } catch (cause) {
      throw new DocumentError(
        'E-NETWORK',
        `cannot reach ${this.describe}: ${cause.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new DocumentError('E-NOT-FOUND', `${relativePath} not found in ${this.describe}`);
    }
    if (!response.ok) {
      throw new DocumentError(
        'E-HTTP',
        `${relativePath}: HTTP ${response.status} ${response.statusText} from ${this.describe}`,
      );
    }

    const value = binary
      ? Buffer.from(await response.arrayBuffer())
      : await response.text();
    this.cache.set(cacheKey, value);
    return value;
  }

  async fetchIndex() {
    const text = await this.#get(FILE_NAMES.INDEX);
    const doc = parseUtool(text, FILE_NAMES.INDEX);
    checkHeader(doc, FILE_NAMES.INDEX, KIND.INDEX);
    return doc;
  }

  /** @param {string} manifestPath */
  async fetchManifest(manifestPath) {
    const text = await this.#get(manifestPath);
    const doc = parseUtool(text, manifestPath);
    checkHeader(doc, manifestPath, KIND.TOOL);
    return doc;
  }

  /** @param {string} artifactPath */
  async fetchArtifact(artifactPath) {
    return this.#get(artifactPath, { binary: true });
  }

  /** Remote registries are read-only: enumeration is index-driven, not a walk. */
  async listPayloads() {
    const index = await this.fetchIndex();
    return (index.tools ?? []).map((tool) => ({
      id: tool.id,
      dir: null,
      manifestPath: tool.manifestPath ?? `payloads/${tool.id}/${FILE_NAMES.MANIFEST}`,
    }));
  }
}

/**
 * Build the right source for a locator.
 *
 * Accepted forms:
 *   - an absolute or relative directory path  -> LocalRegistrySource
 *   - http(s):// base URL                     -> HttpRegistrySource
 *   - a git URL or a sibling directory named  -> resolved by the CLI beforehand
 *
 * @param {string} locator
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {LocalRegistrySource|HttpRegistrySource}
 */
export function createSource(locator, options = {}) {
  if (/^https?:\/\//i.test(locator)) {
    return new HttpRegistrySource(locator, options);
  }
  if (/^(git@|ssh:\/\/|git:\/\/)/i.test(locator) || /\.git$/i.test(locator)) {
    throw new DocumentError(
      'E-SOURCE-GIT',
      `git remotes must be cloned first; this backend does not shell out to git. ` +
        `Clone ${locator} and pass the directory instead.`,
    );
  }
  return new LocalRegistrySource(locator);
}
