/**
 * Argument parsing.
 *
 * Deliberately tiny and dependency-free: the CLI surface is fixed and small, and
 * a shell-out seam is easier to reason about than a general parser. Boolean
 * flags never consume the next token, so `utool install core-editor-utils`
 * works without a trailing separator.
 */

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  'auto-provider',
  'dry-run',
  'force',
  'json',
  'records',
  'quiet',
  'no-hash',
  'write-index',
  'help',
  'version',
]);

/**
 * Flags that take a value and may appear more than once.
 *
 * These accumulate into an array. Without this list a repeatable flag would simply
 * overwrite itself, so `--also-engine godot --also-engine unreal` would silently
 * keep only the last engine, and `--mirror a --mirror b` only the last mirror.
 */
const REPEATABLE_FLAGS = new Set(['also-engine', 'mirror']);

/** @type {Record<string,string>} maps a flag to its canonical camelCase key */
const KEY_ALIASES = {
  'dry-run': 'dryRun',
  'no-hash': 'noHash',
  'write-index': 'writeIndex',
  'host-unity': 'hostUnity',
  'host-dotnet': 'hostDotnet',
};

/**
 * @param {string[]} argv
 * @returns {{command: string|null, positionals: string[], flags: Record<string, any>, unknown: string[]}}
 */
export function parseArgs(argv) {
  const positionals = [];
  /** @type {Record<string, any>} */
  const flags = {};
  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-v') {
      flags.version = true;
      continue;
    }
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    // Support both `--flag value` and `--flag=value`.
    const equals = token.indexOf('=');
    const name = (equals === -1 ? token.slice(2) : token.slice(2, equals)).trim();
    const valueFromEquals = equals === -1 ? undefined : token.slice(equals + 1);

    if (!name) {
      unknown.push(token);
      continue;
    }

    const key = KEY_ALIASES[name] ?? name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const repeatable = REPEATABLE_FLAGS.has(name);

    if (BOOLEAN_FLAGS.has(name)) {
      flags[key] = valueFromEquals === undefined ? true : valueFromEquals !== 'false';
      continue;
    }

    if (valueFromEquals !== undefined) {
      if (repeatable) {
        (flags[key] ??= []).push(valueFromEquals);
      } else {
        flags[key] = valueFromEquals;
      }
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('--') && next.length > 2)) {
      // A value-taking flag with no value: record it as unknown so a typo is
      // reported rather than silently treated as an empty string.
      unknown.push(token);
      continue;
    }
    if (repeatable) {
      (flags[key] ??= []).push(next);
    } else {
      flags[key] = next;
    }
    i += 1;
  }

  const command = positionals.length > 0 ? positionals.shift() : null;
  return { command, positionals, flags, unknown };
}
