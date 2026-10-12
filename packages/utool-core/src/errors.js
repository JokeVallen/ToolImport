/**
 * Structured errors.
 *
 * Resolution failures are values, not exceptions, wherever a caller may want to
 * report several problems at once. Exceptions are reserved for "cannot continue
 * at all": malformed documents, digest mismatches, unsafe archives.
 *
 * Every error carries a stable `code` and an `exitCode` from the CLI contract in
 * docs/FRONTEND-INTEGRATION.md section 8, so a shell caller and the Unity front
 * end can both branch on it.
 */

/** Exit codes: the CLI's contract with shells and with the Unity front end. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  RESOLUTION: 3,
  PLATFORM: 4,
});

export class UtoolError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. E-ARTIFACT-HASH
   * @param {string} message human-readable explanation
   * @param {{exitCode?: number, detail?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'UtoolError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.FAILURE;
    this.detail = options.detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** A document is malformed, or uses a kind/formatVersion we do not implement. */
export class DocumentError extends UtoolError {
  constructor(code, message, detail) {
    super(code, message, { exitCode: EXIT.FAILURE, detail });
    this.name = 'DocumentError';
  }
}

/** Dependency graph could not be satisfied: unknown id, bad constraint, cycle. */
export class ResolutionError extends UtoolError {
  constructor(code, message, detail) {
    super(code, message, { exitCode: EXIT.RESOLUTION, detail });
    this.name = 'ResolutionError';
  }
}

/** Host is below a declared floor: minUnityVersion / minDotNetVersion. */
export class PlatformError extends UtoolError {
  constructor(code, message, detail) {
    super(code, message, { exitCode: EXIT.PLATFORM, detail });
    this.name = 'PlatformError';
  }
}

/** An artifact is missing, the wrong size, the wrong digest, or unsafe. */
export class ArtifactError extends UtoolError {
  constructor(code, message, detail) {
    super(code, message, { exitCode: EXIT.FAILURE, detail });
    this.name = 'ArtifactError';
  }
}

/**
 * Collects findings so a validation run can report everything instead of
 * stopping at the first problem. Used by the registry validator.
 */
export class DiagnosticBag {
  constructor() {
    /** @type {{code: string, message: string}[]} */
    this.errors = [];
    /** @type {{code: string, message: string}[]} */
    this.warnings = [];
    this.checks = 0;
  }

  note() {
    this.checks += 1;
  }

  error(code, message) {
    this.checks += 1;
    this.errors.push({ code, message });
  }

  warn(code, message) {
    this.warnings.push({ code, message });
  }

  get ok() {
    return this.errors.length === 0;
  }
}
