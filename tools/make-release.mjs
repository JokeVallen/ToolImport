/**
 * Build the release artifacts from the git tree, into `dist/`.
 *
 * WHY FROM GIT AND NOT FROM THE WORKING DIRECTORY
 * ------------------------------------------------
 * A zip of the working directory ships whatever is lying around: node_modules, a half-written
 * file, a .env somebody made to test something. `git archive` packs exactly what the tag names,
 * so "the release is what the repository says" is true by construction rather than by care.
 *
 * WHY THERE ARE THREE PAIRS OF HANDS
 * ----------------------------------
 * Someone using the CLI wants the source; someone using Unity wants the Editor folder; someone
 * using Godot wants the addons folder. One archive serves none of them well, and the front ends
 * carry no dependencies of their own.
 *
 * Usage:
 *   node tools/make-release.mjs            build into dist/
 *   node tools/make-release.mjs --clean    remove dist/ first
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');

/**
 * The artifacts, in the order they are built.
 *
 * `tree` is a path inside the repository; `git archive <rev>:<tree>` packs that directory as the
 * archive root, which is what a user unzips into a project.
 */
const ARTIFACTS = [
  {
    file: (version) => `toolimport-${version}.zip`,
    tree: null, // whole repository
    // A top-level folder, because the source archive is unzipped somewhere and should not
    // scatter its own src/ and docs/ into that directory.
    prefix: (tag) => `${tag}/`,
    note: 'the whole repository, for reading and for running the CLI',
  },
  {
    file: (version) => `toolimport-unity-${version}.zip`,
    tree: 'frontends/unity-editor/Editor',
    // No wrapper folder: the archive IS the contents of an Assets subfolder, and adding a
    // versioned directory would make "unzip into Assets/ToolImport" wrong.
    prefix: () => '',
    note: 'the Unity editor scripts - unzip into Assets/ToolImport/',
  },
  {
    file: (version) => `toolimport-godot-${version}.zip`,
    tree: 'frontends/godot-editor/addons/tool_import',
    prefix: () => '',
    note: 'the Godot addon - unzip into res://addons/tool_import/',
  },
];

function version() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** Run git and return stdout, failing loudly rather than shipping a half-built archive. */
function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function build(artifact, tag, target) {
  const args = ['archive', '--format=zip', '-o', target];
  const prefix = artifact.prefix(tag);
  if (prefix !== '') args.push(`--prefix=${prefix}`);
  args.push(artifact.tree === null ? tag : `${tag}:${artifact.tree}`);
  git(args);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  if (process.argv.includes('--clean') && existsSync(dist)) {
    rmSync(dist, { recursive: true, force: true });
  }
  mkdirSync(dist, { recursive: true });

  const tag = `v${version()}`;
  // The tag has to exist, because `git archive` above is what makes the contents honest. Checked
  // here rather than hoping the release command names the same thing.
  try {
    git(['rev-parse', '--verify', `refs/tags/${tag}`]);
  } catch {
    console.error(
      `no tag ${tag}. The archives are built from the tag, not the working tree, so the tag is ` +
        `created first:\n  git tag -a ${tag} -m "${version()}"`,
    );
    return 1;
  }

  const built = [];
  for (const artifact of ARTIFACTS) {
    const name = artifact.file(version());
    const target = path.join(dist, name);
    build(artifact, tag, target);
    built.push({ name, note: artifact.note, digest: sha256(target) });
    console.log(`${name}  ${artifact.note}`);
  }

  const sums = built.map((entry) => `${entry.digest}  ${entry.name}`).join('\n') + '\n';
  writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums, 'utf8');

  const files = readdirSync(dist).sort();
  console.log(`\ndist/: ${files.length} file(s)`);
  return 0;
}

process.exitCode = main();
