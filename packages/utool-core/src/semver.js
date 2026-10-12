/**
 * semver-lite: version parsing and dependency constraint satisfaction.
 *
 * The registry publishes `major.minor.patch` with an optional prerelease suffix.
 * Ordering uses the numeric triple only; the suffix is a label, not a precedence
 * (docs/SPEC.zh-CN.md R-VER-2). Keeping this deliberately small is what lets the
 * Python validator and this module agree without a shared dependency.
 */

import { CONSTRAINT_PATTERN, STRICT_VERSION_PATTERN } from './format.js';

/**
 * Parse a version into its comparable triple plus label.
 *
 * @param {string} text
 * @returns {{major: number, minor: number, patch: number, prerelease: string|null, raw: string}}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`version must be a string, got ${typeof text}`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$/.exec(text.trim());
  if (!match) {
    throw new TypeError(`not a valid version: ${JSON.stringify(text)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: text.trim(),
  };
}

/** @returns {boolean} true when `text` is a well-formed strict version */
export function isVersion(text) {
  return typeof text === 'string' && STRICT_VERSION_PATTERN.test(text.trim());
}

/** @returns {number} negative, zero or positive, comparing the numeric triple */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/**
 * Does `version` satisfy `constraint`?
 *
 *   ^1.2.3  ->  >= 1.2.3, same major
 *   ~1.2.3  ->  >= 1.2.3, same major.minor
 *   >=, >, <=, <  ->  half-open bounds
 *   1.4.2 or =1.4.2  ->  exact triple
 *   undefined/null/''  ->  any version the registry provides
 *
 * @param {string} version concrete version from the registry
 * @param {string|null|undefined} constraint range expression
 * @returns {boolean}
 */
export function satisfies(version, constraint) {
  if (constraint === undefined || constraint === null || constraint === '') return true;
  if (!isVersion(version)) {
    throw new TypeError(`not a valid version: ${JSON.stringify(version)}`);
  }

  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(constraint.trim());
  if (!match) {
    throw new TypeError(`not a valid constraint: ${JSON.stringify(constraint)}`);
  }
  const operator = match[1] ?? '=';
  const targetText = match[2].trim();
  if (!isVersion(targetText)) {
    throw new TypeError(`constraint target is not a version: ${JSON.stringify(constraint)}`);
  }

  const v = parseVersion(version);
  const t = parseVersion(targetText);
  const cmp = compareVersions(v, t);

  switch (operator) {
    case '=':
      return cmp === 0;
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    case '^':
      return cmp >= 0 && v.major === t.major;
    case '~':
      return cmp >= 0 && v.major === t.major && v.minor === t.minor;
    default:
      throw new TypeError(`unsupported operator: ${operator}`);
  }
}

/** @returns {boolean} true when `text` is a well-formed constraint expression */
export function isConstraint(text) {
  return typeof text === 'string' && CONSTRAINT_PATTERN.test(text.trim());
}

/**
 * Unity versions compare by year, then minor, then patch, then release stage
 * (a < b < f < p), then the stage number. `2019.4` has no patch or stage.
 *
 * @param {string} text
 * @returns {{year:number, minor:number, patch:number, stage:number, stageNumber:number}}
 */
export function parseUnityVersion(text) {
  const match = /^(\d{4})\.(\d+)(?:\.(\d+)([abfp])(\d+))?$/.exec(String(text).trim());
  if (!match) {
    throw new TypeError(`not a valid Unity version: ${JSON.stringify(text)}`);
  }
  const stageOrder = { a: 0, b: 1, f: 2, p: 3 };
  return {
    year: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    stage: match[4] === undefined ? 2 : stageOrder[match[4]],
    stageNumber: match[5] === undefined ? 0 : Number(match[5]),
  };
}

/**
 * Compare two Unity versions. Note that a bare `2019.4` is treated as the
 * released `f` build of patch 0, which is what a host editor reports.
 *
 * @returns {number}
 */
export function compareUnityVersions(a, b) {
  const left = parseUnityVersion(a);
  const right = parseUnityVersion(b);
  for (const key of ['year', 'minor', 'patch', 'stage', 'stageNumber']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

/**
 * Compare .NET API compatibility levels, which are `MAJOR.MINOR`.
 *
 * @returns {number}
 */
export function compareDotNetVersions(a, b) {
  const parse = (text) => {
    const match = /^(\d+)\.(\d+)$/.exec(String(text).trim());
    if (!match) throw new TypeError(`not a valid .NET version: ${JSON.stringify(text)}`);
    return { major: Number(match[1]), minor: Number(match[2]) };
  };
  const left = parse(a);
  const right = parse(b);
  return left.major !== right.major ? left.major - right.major : left.minor - right.minor;
}
