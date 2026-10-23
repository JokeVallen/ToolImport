/**
 * Compile and load the Godot addon with a real Godot binary.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first release of the addon was written without a Godot on this machine, and it did not
 * compile: `EditorSettings.get_setting(key, default)` takes one argument, and several `:=`
 * declarations had no type to infer from. Neither mistake is visible to `node --test`, and the
 * type-check harness is C#-only. Shipping a front end nobody compiled is the actual defect;
 * this script is the compiler.
 *
 * Two passes, because they catch different things:
 *
 *   1. `--check-only --script` per file - parse and static type errors, one file at a time.
 *   2. `--editor --quit` with the plugin enabled - `_enter_tree` and `_ready` actually run, so
 *      a wrong API name that parses fine still fails here.
 *
 * Usage:
 *   node tools/godot-check.mjs                 find Godot automatically
 *   node tools/godot-check.mjs --godot <exe>   use this binary
 *   GODOT_BIN=<exe> node tools/godot-check.mjs
 *
 * Exits 0 when the addon compiles and loads, 1 when it does not, and 0 with a SKIP message when
 * no Godot is installed - a machine without Godot cannot check Godot, and pretending otherwise
 * would make CI red for the wrong reason.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ADDON = path.join(root, 'frontends', 'godot-editor', 'addons', 'tool_import');

/** Where a Windows installer usually leaves it, plus the env var for anything else. */
const CANDIDATE_DIRECTORIES = [
  'C:\\Program Files\\Godot',
  'C:\\Program Files (x86)\\Godot',
  'C:\\Godot',
  'D:\\Program Files\\Godot',
  'D:\\Godot',
];

function findGodot() {
  const override = argumentValue('--godot') ?? process.env.GODOT_BIN;
  if (override) return existsSync(override) ? override : null;

  for (const directory of CANDIDATE_DIRECTORIES) {
    if (!existsSync(directory)) continue;
    for (const found of findConsoleBinary(directory, 3)) return found;
  }
  return null;
}

/**
 * Godot on Windows ships two executables in a folder whose NAME ends in `.exe`, and the plain one
 * writes nothing to a pipe. Only the `_console` build is usable from a script, so it is the one
 * looked for.
 */
function findConsoleBinary(directory, depth) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...findConsoleBinary(full, depth - 1));
    } else if (entry.name.startsWith('Godot') && entry.name.endsWith('_console.exe')) {
      found.push(full);
    }
  }
  return found;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(godot, args, cwd) {
  try {
    const stdout = execFileSync(godot, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: stdout };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return { code: error.status ?? 1, output };
  }
}

/** Lines worth showing: a script error, not the editor's progress output. */
function errorsIn(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /SCRIPT ERROR|Parse Error|Compile Error|Failed to load script|Invalid (call|access)/.test(line))
    .map((line) => line.trim());
}

function main() {
  const godot = findGodot();
  if (!godot) {
    console.log('SKIP - no Godot binary found. Set GODOT_BIN or pass --godot <exe> to check the addon.');
    return 0;
  }

  const scripts = readdirSync(ADDON)
    .filter((name) => name.endsWith('.gd'))
    .sort();
  if (scripts.length === 0) {
    console.error(`no .gd files in ${ADDON}`);
    return 1;
  }

  // A scratch project, so the check never depends on the state of somebody's real project.
  const project = mkdtempSync(path.join(tmpdir(), 'toolimport-godot-'));
  try {
    cpSync(ADDON, path.join(project, 'addons', 'tool_import'), { recursive: true });
    writeFileSync(
      path.join(project, 'project.godot'),
      [
        'config_version=5',
        '',
        '[application]',
        '',
        'config/name="toolimport-check"',
        '',
        '[editor_plugins]',
        '',
        'enabled=PackedStringArray("res://addons/tool_import/plugin.cfg")',
        '',
      ].join('\n'),
      'utf8',
    );

    console.log(`checking ${scripts.length} script(s) with ${path.basename(godot)}`);

    let failures = 0;
    for (const script of scripts) {
      const result = run(godot, ['--headless', '--path', project, '--check-only', '--script', `res://addons/tool_import/${script}`], project);
      const errors = errorsIn(result.output);
      if (result.code !== 0 || errors.length > 0) {
        failures += 1;
        console.error(`  FAIL ${script}`);
        for (const line of errors.length > 0 ? errors : [result.output.trim()]) {
          console.error(`       ${line}`);
        }
      } else {
        console.log(`  ok   ${script}`);
      }
    }

    // The pass that starts the editor: this is what proves the dock can be constructed.
    const load = run(godot, ['--headless', '--path', project, '--editor', '--quit'], project);
    const loadErrors = errorsIn(load.output);
    if (load.code !== 0 || loadErrors.length > 0) {
      failures += 1;
      console.error('  FAIL loading the editor with the plugin enabled');
      for (const line of loadErrors.length > 0 ? loadErrors : [load.output.trim()]) {
        console.error(`       ${line}`);
      }
    } else {
      console.log('  ok   editor loads with the plugin enabled');
    }

    if (failures > 0) {
      console.error(`\nFAILED - ${failures} check(s) failed`);
      return 1;
    }
    console.log('\nPASSED - the Godot addon compiles and loads');
    return 0;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

process.exitCode = main();
