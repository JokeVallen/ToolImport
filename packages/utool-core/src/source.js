/**
 * Registry sources: where .yaml documents and artifacts come from.
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
  /** @param {string} root absolute or relative directory holding index.yaml */
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
      // A 404 on the INDEX is usually not "the registry is missing one file": it means the
      // URL is a default nobody has published to, or points at the wrong branch/owner. Saying
      // only "not found" left a first-time user with no next step, so the index case names the
      // two things that actually fix it.
      const hint = relativePath === FILE_NAMES.INDEX
        ? ' - if this is a default remote, it has nothing published yet;'
          + ' pass --registry <path to a checkout> or set the registry in settings'
        : '';
      throw new DocumentError('E-NOT-FOUND', `${relativePath} not found in ${this.describe}${hint}`);
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
 * @param {{fetchImpl?: typeof fetch, mirrors?: string[]}} [options]
 *   `mirrors` are alternative base URLs for the SAME registry layout, tried in order when
 *   the primary is unreachable. See MirroredRegistrySource.
 * @returns {LocalRegistrySource|HttpRegistrySource|MirroredRegistrySource}
 */
export function createSource(locator, options = {}) {
  if (/^https?:\/\//i.test(locator)) {
    const primary = new HttpRegistrySource(locator, options);
    const mirrors = (options.mirrors ?? []).map((url) => new HttpRegistrySource(url, options));
    if (mirrors.length === 0) return primary;
    return new MirroredRegistrySource([primary, ...mirrors], options);
  }
  if (/^(git@|ssh:\/\/|git:\/\/)/i.test(locator) || /\.git$/i.test(locator)) {
    throw new DocumentError(
      'E-SOURCE-GIT',
      `git remotes must be cloned first; this backend does not shell out to git. ` +
        `Clone ${locator} and pass the directory instead.`,
    );
  }
  if ((options.mirrors ?? []).length > 0) {
    // Mirrors are HTTP locations. Accepting them for a local directory would suggest the
    // tool might substitute a remote for a path the caller chose deliberately, which is not
    // a silent decision this backend should make.
    throw new DocumentError(
      'E-MIRROR-LOCAL',
      'mirrors apply to an HTTP registry; a local directory is already reachable and exact',
    );
  }
  return new LocalRegistrySource(locator);
}

/**
 * One registry layout, reachable at several base URLs.
 *
 * A mirror here means the SAME bytes at a different address - identical `index.yaml`, identical
 * relative paths - so failing over is a matter of re-issuing the request elsewhere, and nothing
 * about the data changes. That equality is the whole point: a mirror whose layout differs would
 * need path rewriting, and a rewritten path is a different artifact that the recorded `sha256`
 * would then have to catch, which is a worse way to find out.
 *
 * Failover happens only when a mirror is UNREACHABLE. A 404 is not a reason to try elsewhere:
 * it means the registry answered and does not have that file, and asking a second host the same
 * question cannot change the answer - it would only make a real "missing artifact" error slower
 * and vaguer.
 *
 * Every success is served from the first source that has it, and every attempt is recorded so
 * the caller can say which host a tool actually came from. That matters for trust: the artifact
 * digests prove the bytes are right, so what a user needs to know is which host supplied them.
 */
export class MirroredRegistrySource {
  /**
   * @param {HttpRegistrySource[]} sources in preference order, primary first
   * @param {{onFailover?: (from: string, to: string, reason: string) => void}} [options]
   */
  constructor(sources, options = {}) {
    if (sources.length === 0) throw new TypeError('MirroredRegistrySource needs at least one source');
    this.sources = sources;
    this.kind = 'http';
    this.describe = sources[0].describe;
    this.onFailover = options.onFailover ?? null;
    /** @type {{from: string, to: string, reason: string}[]} */
    this.failovers = [];
    /** @type {Map<string, HttpRegistrySource>} path -> the source that served it */
    this.origin = new Map();
  }

  /** Which base URL served a given relative path, once it has been read. */
  originOf(relativePath) {
    return this.origin.get(relativePath)?.describe ?? null;
  }

  /** Every base URL in use, primary first. */
  get mirrors() {
    return this.sources.map((source) => source.describe);
  }

  /**
   * Try each source in order, stopping at the first that answers.
   *
   * `E-NETWORK` is the only error that moves on to the next source, because it is the only one
   * that says "this host did not answer". Everything else - a 404, a malformed document, a
   * digest mismatch - came from a registry that answered, and repeating the question elsewhere
   * would either waste time or, worse, mask a genuine problem behind a different host's data.
   */
  async #firstThatAnswers(relativePath, read) {
    const attempts = [];
    for (const source of this.sources) {
      try {
        const result = await read(source);
        this.origin.set(relativePath, source);
        return result;
      } catch (cause) {
        attempts.push({ source, cause });
        if (cause.code !== 'E-NETWORK') throw cause;
      }
    }

    // Every host failed to answer. Report the primary's failure but name the others, so a
    // user with two broken mirrors is not told about only one of them.
    const detail = attempts
      .map(({ source, cause }) => `${source.describe} (${cause.message})`)
      .join('; ');
    throw new DocumentError('E-NETWORK', `no registry mirror could be reached: ${detail}`);
  }

  async fetchIndex() {
    return this.#firstThatAnswers('index.yaml', (source) => source.fetchIndex());
  }

  async fetchManifest(manifestPath) {
    return this.#firstThatAnswers(manifestPath, (source) => source.fetchManifest(manifestPath));
  }

  async fetchArtifact(artifactPath) {
    return this.#firstThatAnswers(artifactPath, (source) => source.fetchArtifact(artifactPath));
  }
}
