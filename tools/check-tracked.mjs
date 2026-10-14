/**
 * Fail if a source file that the tool needs would be missing from a clone.
 *
 * `apps/cli/bin/utool.js` was excluded for many commits by an unanchored `[Bb]in/` rule meant for
 * C# build output. Everything worked locally, where the file existed, so no test noticed - and a
 * fresh clone, which is what a repository migration produces, had no CLI at all.
 *
 * The check has to ask the right question. `git check-ignore` answers "is this path ignored", which
 * is FALSE for a file already in the index - so a naive version of this guard passes even with the
 * offending rule restored, and proves nothing. The question that matters is "is this path in the
 * index", which `git ls-files` answers directly.
 *
 * Usage: node tools/check-tracked.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/** Files a clone must contain for the tool to run at all. */
const REQUIRED = [
  'apps/cli/bin/utool.js',
  'apps/cli/lib/records.js',
  'apps/cli/lib/args.js',
  'packages/utool-core/src/index.js',
  'packages/utool-core/src/format.js',
  'providers/engine-unity/src/index.js',
  'providers/engine-godot/src/index.js',
  'package.json',
  // The Unity front end and its check harness. Both were hit by the same class of
  // bug: an unanchored ignore rule (there `[Bb]in/`, here `*.csproj`) silently kept
  // a needed file out of every commit. The harness is the worse case of the two,
  // because `npm run check:csharp` then failed on a clone AND blamed the front-end
  // sources, sending anyone who hit it to look in the wrong place.
  'frontends/unity-editor/Editor/ImportToolWindow.cs',
  'frontends/unity-editor/Editor/BackendRecords.cs',
  'frontends/unity-editor/Editor/CliRunner.cs',
  'tools/csharp-check.mjs',
  'tools/csharp-check/Check.csproj',
  'tools/csharp-check/UnityStubs.cs',
  'tools/csharp-check/BehaviourTests.cs',
];

let tracked;
try {
  tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.replace(/\\/g, '/')),
  );
} catch {
  process.stdout.write('  SKIPPED - not a Git checkout\n');
  process.exit(0);
}

let problems = 0;

for (const relative of REQUIRED) {
  const absolute = path.join(ROOT, relative);
  const posix = relative.replace(/\\/g, '/');

  if (!existsSync(absolute)) {
    process.stdout.write(`  FAIL  ${relative} does not exist on disk\n`);
    problems += 1;
    continue;
  }

  if (!tracked.has(posix)) {
    // Say which rule is responsible when one is, because that is the fix.
    let rule = '';
    try {
      rule = execFileSync('git', ['check-ignore', '-v', relative], { cwd: ROOT, encoding: 'utf8' })
        .trim();
    } catch {
      rule = 'not ignored, but not added either';
    }
    process.stdout.write(`  FAIL  ${relative} is not tracked - a clone would not have it\n`);
    process.stdout.write(`          ${rule}\n`);
    problems += 1;
  }
}

process.stdout.write(
  problems === 0
    ? '\nPASSED - every file the tool needs is tracked by Git\n'
    : `\nFAILED - ${problems} required file(s) would be missing from a clone\n`,
);
process.exitCode = problems === 0 ? 0 : 1;
