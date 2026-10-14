/**
 * Type-check the Unity front end without Unity.
 *
 * The front end is C# that cannot be compiled here, so an error in it would only
 * surface when someone imports it into an editor. This runner copies the real
 * sources next to the Unity stubs and runs `dotnet build`, which catches typos,
 * stale field names and signature drift in seconds.
 *
 * It exists because a v2 port bug in the CLI (`tool.files` after the field became
 * `tool.items`) was found by an end-to-end run, not by review. The C# had the same
 * class of staleness and no equivalent check.
 *
 * Usage:
 *   node tools/csharp-check.mjs            copy sources, build, report
 *   node tools/csharp-check.mjs --keep     leave the generated sources in place
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const buildDir = path.join(here, 'csharp-check');
const sourceDir = path.join(root, 'frontends', 'unity-editor', 'Editor');
const generatedDir = path.join(buildDir, 'generated');

async function main() {
  if (!existsSync(sourceDir)) {
    console.error(`no front-end sources at ${sourceDir}`);
    return 1;
  }
  if (!existsSync(path.join(buildDir, 'UnityStubs.cs'))) {
    console.error(`missing ${path.join(buildDir, 'UnityStubs.cs')}; the harness cannot stub Unity without it`);
    return 1;
  }
  // Without this the build dies with MSB1003 and the message below would blame the
  // front-end sources, which are innocent. That happened once because *.csproj was
  // gitignored and this file never reached the repository.
  if (!existsSync(path.join(buildDir, 'Check.csproj'))) {
    console.error(
      `missing ${path.join(buildDir, 'Check.csproj')}: the harness project file is not present.\n` +
        `This is a repository problem, not a problem with the front-end sources. ` +
        `Check that .gitignore does not exclude *.csproj.`,
    );
    return 1;
  }

  // Copy the real sources into a generated folder so the stub and the front end
  // compile together while the front end itself stays out of the project.
  await rm(generatedDir, { recursive: true, force: true });
  await mkdir(generatedDir, { recursive: true });

  // Force a recompile. Without this, editing a copied source can be missed and the
  // checks run against yesterday's binary, which reports a stale pass or a stale
  // failure -- both worse than no check at all.
  await rm(path.join(buildDir, 'obj'), { recursive: true, force: true });
  await rm(path.join(buildDir, 'bin'), { recursive: true, force: true });

  const sources = (await readdir(sourceDir)).filter((name) => name.endsWith('.cs'));
  for (const name of sources) {
    await cp(path.join(sourceDir, name), path.join(generatedDir, name));
  }
  console.log(`type-checking ${sources.length} file(s) from frontends/unity-editor/Editor`);

  const build = spawnSync('dotnet', ['build', '-v', 'quiet', '--nologo'], {
    cwd: buildDir,
    stdio: 'inherit',
    shell: false,
  });

  if (build.error) {
    console.error(
      `could not run dotnet: ${build.error.message}\n` +
        `Install the .NET SDK, or skip this check if the front end is not being changed.`,
    );
    return 1;
  }

  if (build.status !== 0) {
    if (!process.argv.includes('--keep')) {
      await rm(generatedDir, { recursive: true, force: true });
    }
    console.error('C# type-check FAILED. The errors above are in the real front-end sources.');
    return build.status ?? 1;
  }

  console.log('C# front end type-checks clean.');

  // A clean compile is not enough on its own. Reading the wrong field of a record
  // compiles perfectly and is still wrong, so the reader is executed here against
  // real CLI output shapes.
  const run = spawnSync('dotnet', ['run', '--no-build', '-v', 'quiet', '--nologo'], {
    cwd: buildDir,
    stdio: 'inherit',
    shell: false,
  });

  if (!process.argv.includes('--keep')) {
    await rm(generatedDir, { recursive: true, force: true });
  } else {
    console.log(`generated sources kept in ${generatedDir}`);
  }

  if (run.error) {
    console.error(`could not run the behaviour checks: ${run.error.message}`);
    return 1;
  }
  if (run.status !== 0) {
    console.error('C# behaviour checks FAILED (see above).');
    return run.status ?? 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`unexpected failure: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
