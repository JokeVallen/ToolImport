#!/usr/bin/env node
/**
 * utool -- command line interface to the ToolRegistry import-tool backend.
 *
 * This is the seam that keeps the tool usable when Unity itself is unusable: if a
 * project has compile errors, no editor assembly loads and the Unity front end
 * cannot run at all, but this CLI still inspects, validates and installs.
 *
 * Every command prints JSON with --json, and exits with a code from
 * docs/FRONTEND-INTEGRATION.zh-CN.md section 8:
 *   0 ok  1 failure  2 usage  3 resolution  4 platform
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  EXIT,
  UtoolError,
  KIND,
  FILE_NAMES,
  ReceiptStore,
  LocalRegistrySource,
  createSource,
  buildIndex,
  executeInstall,
  loadUtool,
  checkHeader,
  planInstallation,
  resolveSelection,
  toManifest,
  SchemaValidator,
  validateRegistry,
} from '@toolimport/utool-core';

import { createRequirementChecker, loadAdapters } from '../lib/adapters.js';
import { parseArgs } from '../lib/args.js';
import { writeIndexFile } from '../lib/write-index.js';
import { detectHost } from '../lib/host.js';
import * as out from '../lib/output.js';
import * as rec from '../lib/records.js';

/** True when stdout must carry records instead of prose or JSON. */
const inRecords = (flags) => Boolean(flags.records) && !flags.json;

const COMMANDS = new Set([
  'list', 'show', 'plan', 'verify', 'install', 'uninstall', 'rollback', 'status', 'validate',
  'digest',
]);

const USAGE = `utool -- ToolRegistry import tool (backend CLI)

Usage: utool <command> [options]

Commands
  list                              list every tool the registry offers
  show <id>[@<version>]             full metadata for one tool
  plan <id...>                      resolve dependencies and print the install plan
  verify <id...>                    verify artifacts without writing anything
  install <id...>                   install tools into a Unity project
  uninstall <id...>                 remove tools recorded by their receipts
                                    refuses when another installed tool still
                                    depends on one; --force overrides that
  rollback <id...>                  report the version pointer for installed tools
  status                            list what the project has installed
  validate [<registry>]             validate a registry (CI gate)
  digest <file...>                  print size and sha256 ready to paste into a manifest

Options
  --tag <name>            list: only tools carrying this tag (repeatable, comma-separated)
  --provides <capability> list: only tools PROVIDING this capability. Use it to answer
                          "what can satisfy the capability this tool injects?"
  --injects <capability>  list: only tools injecting this capability
  --depends-on <id>       list: only tools depending on this tool
  --type <type>           list: only tools of this type (tool-library, editor-tool, ...)
  --engine-filter <name>  list: only tools supporting this engine
  --search <text>         list: only tools whose DISPLAY NAME contains this text
  --version <v>           install this version of a tool instead of the default
  --registry <path|url>   registry location. Default: found automatically - the
                          conventional ToolRegistry near the working
                          directory, or any directory holding both index.yaml
                          and payloads/
  --mirror <url>          an additional host serving the SAME registry layout;
                          repeatable, tried in the order given, after --registry.
                          Also read from UTOOL_MIRROR (comma or semicolon
                          separated). A mirror is only consulted when the
                          previous host cannot be reached at all: a 404 or a
                          malformed document is an answer, not an outage
  --project <dir>         project root (default: current directory)
  --into <dir>            install the tool you asked for into this project-relative
                          directory instead of the one its manifest declares, e.g.
                          Assets/Plugins/IMGUILib. Needs exactly one tool id:
                          a dependency keeps its own declared layout. The directory
                          is recorded in the receipt, so uninstall still finds it
  --engine <name>         target engine, e.g. unity (default: unity)
  --also-engine <name>    additionally plan this engine's target; repeatable. Use
                          it to install one cross-engine tool into two engines
  --host-unity <ver>      host Unity version, e.g. 2021.3.5f1 (enables the gate)
  --host-dotnet <ver>     host .NET API level, e.g. 4.6 or 6.0 (enables the gate)
  --auto-provider         when a tool injects a capability nothing in the plan
                          provides, select a provider for it. Off by default:
                          silently adding a tool is worse than explaining the gap
  --dry-run               plan and verify, write nothing
  --no-hash               skip sha256 verification (size and format only)
  --write-index           regenerate index.yaml (validate only)
  --json                  machine-readable output (one JSON document)
  --records               line-oriented output (TAB separated), for embedders
  --quiet                 suppress per-check output
  -h, --help              this message
  -v, --version           print the version

Engines
  The core knows no engine. Unity support comes from providers/engine-unity, which
  registers the unitypackage container and the Unity/.NET version comparisons. An
  engine with no adapter is still valid registry data; the CLI names it and stops
  rather than guessing how to compare its versions.

Output modes
  default    aligned tables and prose, for a terminal
  --json     one JSON document on stdout
  --records  one record per line, TAB separated, for the Unity front end. Records
             are: META, TOOL, TARGET, DETAIL, DEPENDENCY, WILLINSTALL, PROBLEM,
             PLANTOOL, PLANFILE, PLAN, INSTALLED, INSTALLEDFILE, SKIPPED, RESULT,
             RECEIPT, WARNING, ERROR.
             A value containing TAB, CR or LF is escaped as \\t, \\r, \\n.

Exit codes: 0 ok, 1 failure, 2 usage, 3 resolution, 4 platform.
`;

async function main(argv) {
  const parsed = parseArgs(argv);
  const { command, positionals, flags } = parsed;

  if (flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  // `-v` alone asks for the CLI's own version and sets a boolean. `--version <v>` takes a
  // value and pins a TOOL version. Both landed on `flags.version`, and testing it for
  // truthiness made the pin print "utool 0.1.0" and exit - so the advertised
  // `--version <v>` silently did the opposite of what it says. Only the boolean is the
  // CLI's own version; a string is a pin, handled where tools are resolved.
  if (flags.version === true) {
    process.stdout.write('utool 0.1.0\n');
    return EXIT.OK;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return EXIT.USAGE;
  }
  if (!COMMANDS.has(command)) {
    process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  const registryLocator =
    flags.registry ??
    (command === 'validate' && positionals[0] ? positionals[0] : null) ??
    findRegistry(process.cwd()) ??
    path.resolve(process.cwd(), '..', 'ToolRegistry');

  switch (command) {
    case 'list':
      return cmdList({ registryLocator, flags });
    case 'show':
      return cmdShow({ registryLocator, flags, positionals });
    case 'plan':
      return cmdPlan({ registryLocator, flags, positionals, dryRunOnly: true });
    case 'verify':
      return cmdPlan({ registryLocator, flags, positionals, dryRunOnly: true, verifyOnly: true });
    case 'install':
      return cmdInstall({ registryLocator, flags, positionals });
    case 'uninstall':
      return cmdUninstall({ flags, positionals });
    case 'rollback':
      return cmdRollback({ flags, positionals });
    case 'status':
      return cmdStatus({ flags });
    case 'validate':
      return cmdValidate({ registryLocator, flags });
    case 'digest':
      return cmdDigest({ positionals, flags });
    default:
      return EXIT.USAGE;
  }
}

/**
 * Print the `size` and `sha256` a manifest must declare for one or more files.
 *
 * These two fields are the least pleasant to fill in by hand: a contributor has to run
 * a hashing tool, copy a 64-character digest without corrupting it, and repeat the
 * whole thing every time they rebuild the artifact. Emitting the exact YAML lines
 * removes the copy step, which is where the mistakes were.
 */
function cmdDigest({ positionals, flags }) {
  if (positionals.length === 0) {
    out.line('digest needs at least one file');
    return EXIT.USAGE;
  }

  let failed = false;
  for (const file of positionals) {
    const resolved = path.resolve(file);
    try {
      const data = readFileSync(resolved);
      const size = data.byteLength;
      const sha = createHash('sha256').update(data).digest('hex');

      if (inRecords(flags)) {
        rec.record('DIGEST', [file, String(size), sha]);
      } else if (flags.json) {
        out.json({ file, size, sha256: sha });
      } else {
        out.line(`${file}`);
        out.line(`      size: ${size}`);
        out.line(`      sha256: '${sha}'`);
      }
    } catch (cause) {
      failed = true;
      if (inRecords(flags)) {
        rec.record('PROBLEM', ['E-DIGEST-READ', `${file}: ${cause.message}`]);
      } else {
        out.warn(`${file}: ${cause.message}`);
      }
    }
  }
  return failed ? EXIT.FAILURE : EXIT.OK;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdList({ registryLocator, flags }) {
  const source = sourceFor(registryLocator, flags);
  const index = await source.fetchIndex();
  const all = index.tools ?? [];

  // Filtering server-side, in the backend rather than in each front end.
  //
  // A front end can filter the listing it already holds, and for the text box that is
  // the right place (it is instant and needs no round trip). These filters are different:
  // they answer questions about the WHOLE registry, including tools a front end has not
  // fetched -- and `--provides` / `--injects` are how a user finds "what can satisfy the
  // capability this tool needs" without opening every tool in turn.
  const tools = applyListFilters(all, flags);

  if (inRecords(flags)) {
    rec.meta(source.describe);
    rec.toolSummaries(tools);
    rec.record('RESULT', [
      'tools', String(tools.length),
      'total', String(all.length),
      'filtered', tools.length === all.length ? 'false' : 'true',
    ]);
    return EXIT.OK;
  }

  if (flags.json) {
    out.json({
      ok: true,
      registry: source.describe,
      count: tools.length,
      total: all.length,
      tools,
    });
  } else {
    out.heading(`Registry ${source.describe}`);

    // A reverse lookup is only useful with the answer, so when a `--provides` filter
    // finds nothing, the capabilities that DO exist are listed. Guessing why a name
    // matched nothing is otherwise the user's problem. Checked BEFORE the empty case,
    // because "no tool matches" is exactly when the name is most likely misspelled.
    const unknownCapabilities = [];
    for (const wanted of splitFilter(flags.provides)) {
      if (!all.some((tool) => (tool.provides ?? []).includes(wanted))) {
        unknownCapabilities.push(wanted);
      }
    }

    if (tools.length === 0) {
      // Say WHICH empty this is, and how to undo it.
      out.line(
        all.length === 0
          ? 'the registry lists no tools.'
          : `no tool matches the filter (${all.length} in the registry). Drop a filter to widen the search.`,
      );
      printKnownCapabilities(all, unknownCapabilities);
      return EXIT.OK;
    }

    out.table(
      ['id', 'version', 'type', 'engines', 'displayName'],
      tools.map((tool) => [
        tool.id,
        // The index carries `latest` plus the full version list now, since a consumer
        // may choose. Appending a marker makes a genuine choice visible in the listing
        // rather than only after asking for details.
        (tool.latest ?? tool.version ?? '') +
          ((tool.versions ?? []).length > 1 ? `  (+${tool.versions.length - 1})` : ''),
        tool.type,
        (tool.engines ?? []).join(','),
        tool.displayName,
      ]),
    );
    out.line('');
    out.line(
      tools.length === all.length
        ? `${tools.length} tool(s). Use 'utool show <id>' for details.`
        : `${tools.length} of ${all.length} tool(s) match.`,
    );

    printKnownCapabilities(all, unknownCapabilities);
  }
  return EXIT.OK;
}

/**
 * Name the capabilities the registry does provide, for a filter that matched nothing.
 *
 * Only printed when a `--provides` filter was used AND that exact name is absent, so a
 * normal listing is never padded with a capability dump.
 *
 * @param {Array<Record<string, any>>} all every tool in the registry
 * @param {string[]} unknown the capability names that matched nothing
 */
function printKnownCapabilities(all, unknown) {
  if (!unknown || unknown.length === 0) return;

  const known = [...new Set(all.flatMap((tool) => tool.provides ?? []))].sort();
  for (const wanted of unknown) {
    out.line('');
    out.line(`nothing provides '${wanted}'.`);
  }
  if (known.length > 0) {
    out.line('capabilities this registry does provide:');
    for (const capability of known) out.line(`  ${capability}`);
  }
}

/** Split a repeatable/comma-separated filter flag into values. */
function splitFilter(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Apply the `list` filters.
 *
 * Every filter is an AND, and each accepts a comma-separated list whose members are ORed
 * within that filter. That is the combination users expect from a search box: "these tags,
 * and this engine" rather than "either".
 *
 * Matching is case-insensitive for the free-text filters (tag, engine, type), because
 * nobody should have to remember that a tag is lowercase. Capability names are compared
 * exactly: they are a namespaced API contract, and `Unity.Window` really is a different
 * identifier from `unity.window`.
 *
 * @param {Array<Record<string, any>>} tools
 * @param {Record<string, any>} flags
 */
function applyListFilters(tools, flags) {
  const tags = splitFilter(flags.tag).map((value) => value.toLowerCase());
  const engines = splitFilter(flags.engineFilter).map((value) => value.toLowerCase());
  const types = splitFilter(flags.type).map((value) => value.toLowerCase());
  const provides = splitFilter(flags.provides);
  const injects = splitFilter(flags.injects);
  const dependencies = splitFilter(flags.dependsOn);
  const text = flags.search ? String(flags.search).toLowerCase() : '';

  return tools.filter((tool) => {
    if (tags.length > 0) {
      const own = (tool.tags ?? []).map((value) => value.toLowerCase());
      if (!tags.some((value) => own.includes(value))) return false;
    }

    if (engines.length > 0) {
      const own = (tool.engines ?? []).map((value) => value.toLowerCase());
      if (!engines.some((value) => own.includes(value))) return false;
    }

    if (types.length > 0) {
      if (!types.includes(String(tool.type ?? '').toLowerCase())) return false;
    }

    if (provides.length > 0) {
      const own = tool.provides ?? [];
      if (!provides.some((value) => own.includes(value))) return false;
    }

    if (injects.length > 0) {
      const own = tool.injects ?? [];
      if (!injects.some((value) => own.includes(value))) return false;
    }

    if (dependencies.length > 0) {
      const own = (tool.dependencies ?? []).map((dep) => dep.id);
      if (!dependencies.some((value) => own.includes(value))) return false;
    }

    if (text) {
      // The DISPLAY NAME only, matching the front end's search box. Searching id, type
      // and tags as well made "s" return a tool whose id begins with "libs", and a match
      // the user cannot see on screen is indistinguishable from a bug.
      const name = String(tool.displayName ?? '');
      if (!name.toLowerCase().includes(text)) return false;
    }

    return true;
  });
}

async function cmdShow({ registryLocator, flags, positionals }) {
  if (positionals.length !== 1) {
    process.stderr.write('usage: utool show <id>[@<version>]\n');
    return EXIT.USAGE;
  }
  // `id@version` selects which release to describe. Without it an editor offering a version
  // picker would show the latest release's description and floors next to a plan for a
  // different version, which is worse than showing nothing.
  const [requested] = positionals;
  const at = requested.indexOf('@');
  const id = at > 0 ? requested.slice(0, at) : requested;
  const wanted = at > 0 ? requested.slice(at + 1) : null;

  const source = sourceFor(registryLocator, flags);
  const index = await source.fetchIndex();
  const summary = (index.tools ?? []).find((tool) => tool.id === id);
  if (!summary) {
    throw new UtoolError('E-NOT-FOUND', `no tool '${id}' in ${source.describe}`);
  }
  const base = toManifest(await source.fetchManifest(summary.manifestPath));

  let manifest = base;
  if (wanted) {
    if (!base.versionNumbers.includes(wanted)) {
      throw new UtoolError(
        'E-VERSION-NOT-FOUND',
        `${id}: no version '${wanted}' is published ` +
        `(available: ${base.versionNumbers.join(', ') || 'none'})`,
      );
    }
    manifest = base.at(wanted);
  }

  if (inRecords(flags)) {
    rec.meta(source.describe);
    rec.toolDetail(manifest.doc, manifest);
    rec.toolTargets(manifest.allTargets);
    rec.record('RESULT', ['ok', 'true']);
    return EXIT.OK;
  }

  if (flags.json) {
    out.json({ ok: true, manifest: manifest.doc });
    return EXIT.OK;
  }

  out.heading(`${manifest.displayName} (${manifest.id})`);
  out.field('type', manifest.type);
  out.field('description', manifest.description);
  out.field('latest', manifest.latest);
  out.field('versions', manifest.versionNumbers.join(', '));
  out.field('engines', manifest.allEngines.join(', ') || '-');
  out.field('tags', manifest.tags.join(', ') || '-');
  out.field('license', manifest.license ?? '-');
  out.field('author', manifest.author ?? '-');
  out.field('deprecated', manifest.deprecated ? 'yes' : 'no');
  if (manifest.homepage) out.field('homepage', manifest.homepage);

  // Per version, then per engine: the floors and the artifact belong to a (version,
  // engine) pair now, so flattening them would lose which is which.
  for (const entry of manifest.versions) {
    out.line('');
    const marks = [
      entry.version === manifest.latest ? 'latest' : null,
      entry.deprecated ? 'deprecated' : null,
      entry.yanked ? 'YANKED' : null,
    ].filter(Boolean);
    out.line(`${entry.version}${marks.length > 0 ? `  [${marks.join(', ')}]` : ''}`);
    if (entry.releasedAt) out.line(`  released  ${entry.releasedAt}`);
    if (entry.notes) out.line(`  notes     ${entry.notes}`);

    for (const target of entry.allTargets) {
      const floors = Object.entries(target.requirements)
        .map(([key, value]) => `${key} ${value}`)
        .join(', ');
      out.line(`  ${target.engine.padEnd(8)} ${target.type}${target.format ? ` (${target.format})` : ''}  ${floors}`);
      if (target.isExternal) {
        const external = target.external;
        out.line(`           ${external.source} ${external.url} @ ${external.ref}`);
      } else {
        out.line(`           ${target.artifactPath}  ${target.artifact.size} bytes`);
        out.line(`           sha256 ${target.artifact.sha256}`);
        if (target.contentRoot) out.line(`           contentRoot ${target.contentRoot}`);
        if (target.targetPath) out.line(`           targetPath ${target.targetPath}`);
      }
      if (target.files.length > 0) {
        out.line(`           installs ${target.files.length} file(s)`);
        for (const file of target.files) out.line(`             ${file}`);
      }
    }
  }

  if (manifest.dependencies.length > 0) {
    out.line('');
    out.line('dependencies:');
    for (const dep of manifest.dependencies) {
      const kind = dep.optional ? 'optional' : 'required';
      out.line(`  - ${dep.id} ${dep.version ?? '*'} (${kind})${dep.reason ? ` - ${dep.reason}` : ''}`);
    }
  }
  return EXIT.OK;
}

async function cmdPlan({ registryLocator, flags, positionals, verifyOnly = false }) {
  if (positionals.length === 0) {
    process.stderr.write(`usage: utool ${verifyOnly ? 'verify' : 'plan'} <id...>\n`);
    return EXIT.USAGE;
  }
  const intoProblem = checkIntoScope(flags, positionals);
  if (intoProblem !== null) return intoProblem;
  const source = sourceFor(registryLocator, flags);
  const { containers, adapters, host } = await prepareAdapters(flags);
  const plan = await buildPlan(source, positionals, flags, adapters, host);

  const report = await safePlanInstallation(plan, source, containers, flags);
  if (inRecords(flags)) {
    rec.meta(source.describe);
    rec.providerChoices(plan.providerChoices ?? []);
    rec.problems(plan.problems);
    rec.installPlan(report, { dryRun: true });
    return plan.problems.length > 0 ? plan.exitCode : report.ok ? EXIT.OK : EXIT.FAILURE;
  }
  if (flags.json) {
    out.json({
      ok: report.ok && plan.problems.length === 0,
      registry: source.describe,
      requested: positionals,
      problems: plan.problems,
      plan: report,
    });
  } else {
    out.heading(verifyOnly ? 'Verification' : 'Install plan');
    printPlan(plan, report, flags);
  }

  if (plan.problems.length > 0) return plan.exitCode;
  return report.ok ? EXIT.OK : EXIT.FAILURE;
}

async function cmdInstall({ registryLocator, flags, positionals }) {
  if (positionals.length === 0) {
    process.stderr.write('usage: utool install <id...> [--project <dir>] [--dry-run]\n');
    return EXIT.USAGE;
  }
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const source = sourceFor(registryLocator, flags);
  const intoProblem = checkIntoScope(flags, positionals);
  if (intoProblem !== null) return intoProblem;

  const { containers, adapters, host } = await prepareAdapters(flags);
  const plan = await buildPlan(source, positionals, flags, adapters, host);
  const report = await safePlanInstallation(plan, source, containers, flags);

  if (inRecords(flags)) {
    rec.meta(source.describe);
    rec.providerChoices(plan.providerChoices ?? []);
    rec.problems(plan.problems);
    rec.installPlan(report, { dryRun: Boolean(flags.dryRun) });
    if (plan.problems.length > 0) return plan.exitCode;
    if (!report.ok) return EXIT.FAILURE;
    if (flags.dryRun) return EXIT.OK;

    const outcome = await executeInstall(report, {
      projectRoot,
      source,
      containers,
      receiptStore: new ReceiptStore(projectRoot),
      registryRef: null,
      registryCommit: null,
    });
    rec.installResult(outcome);
    return EXIT.OK;
  }

  if (flags.json) {
    out.json({
      ok: report.ok && plan.problems.length === 0,
      dryRun: Boolean(flags.dryRun),
      project: projectRoot,
      problems: plan.problems,
      plan: report,
    });
  } else {
    out.heading(flags.dryRun ? 'Dry run' : 'Install plan');
    printPlan(plan, report, flags);
  }

  if (plan.problems.length > 0) return plan.exitCode;
  if (!report.ok) return EXIT.FAILURE;

  if (flags.dryRun) {
    if (!flags.json) out.line('\nDry run: nothing was written.');
    return EXIT.OK;
  }

  const result = await executeInstall(report, {
    projectRoot,
    source,
    containers,
    receiptStore: new ReceiptStore(projectRoot),
    registryRef: null,
    registryCommit: null,
  });

  if (flags.json) {
    out.json({ ok: true, project: projectRoot, ...result });
  } else {
    out.line('');
    for (const item of result.installed) {
      out.line(`installed ${item.id}: ${item.files.length} file(s)`);
    }
    for (const item of result.skipped) {
      out.line(`skipped ${item.id}: ${item.reason}`);
    }
    out.line(`\n${result.installed.length} tool(s) installed into ${projectRoot}.`);
  }
  return EXIT.OK;
}

/**
 * Report the recorded version pointer for installed tools.
 *
 * Why this only plans instead of executing: the registry publishes one version per
 * tool, so the artifact a tool replaced is normally no longer in the registry. A
 * "rollback" would have to fetch bytes that are not published. Reporting the exact
 * digest that must be re-fetched is the honest behaviour; pretending to roll back
 * would be worse than refusing.
 */
async function cmdRollback({ flags, positionals }) {
  if (positionals.length === 0) {
    process.stderr.write('usage: utool rollback <id...> [--project <dir>]\n');
    return EXIT.USAGE;
  }

  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const store = new ReceiptStore(projectRoot);

  const plans = [];
  for (const id of positionals) {
    plans.push(await store.planRollback(id));
  }

  if (flags.json) {
    out.json({ ok: plans.every((plan) => plan.ok), project: projectRoot, rollbacks: plans });
  } else {
    out.heading(`Rollback targets for ${projectRoot}`);
    for (const plan of plans) {
      if (!plan.ok) {
        out.line(`  ${plan.toolId}: cannot roll back - ${plan.reason}`);
        continue;
      }
      out.line(`  ${plan.toolId}: currently ${plan.from.slice(0, 12)}... -> recorded previous ${plan.to.slice(0, 12)}...`);
      for (const file of plan.files) out.line(`      ${file}`);
    }
    out.line('');
    out.line(
      'To roll back, the previous artifact must be published in the registry. The registry\n' +
      'currently publishes one version per tool, so the recorded digest names bytes to\n' +
      're-publish rather than bytes this tool can fetch.',
    );
  }

  return plans.every((plan) => plan.ok) ? EXIT.OK : EXIT.FAILURE;
}

async function cmdUninstall({ flags, positionals }) {
  if (positionals.length === 0) {
    process.stderr.write('usage: utool uninstall <id...> --project <dir>\n');
    return EXIT.USAGE;
  }
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const store = new ReceiptStore(projectRoot);
  const plan = await store.planUninstall(positionals);

  // Would this break something that is still installed?
  //
  // Removing a library another tool depends on leaves that tool in place and broken:
  // it compiles only until something references the missing API, and often keeps
  // "working" until it does not. Nothing about that is visible without asking, which
  // is why this is checked rather than left to the user to notice.
  //
  // Refusing by default, with --force as the way through, matches how the rest of
  // this tool treats a destructive action: say what will break, and make the user
  // confirm deliberately.
  const blocked = flags.force ? [] : await store.blockedByDependents(positionals);
  const orphaned = await store.orphanedAfter(positionals);

  if (blocked.length > 0) {
    if (inRecords(flags)) {
      for (const entry of blocked) {
        rec.record('PROBLEM', [
          'E-DEP-REQUIRED',
          `${entry.tool} is still needed by ${entry.stillNeededBy.join(', ')}`,
        ]);
      }
      rec.record('RESULT', ['ok', 'false', 'exitCode', String(EXIT.USAGE)]);
      return EXIT.USAGE;
    }
    if (flags.json) {
      out.json({ ok: false, project: projectRoot, blocked, ...plan });
      return EXIT.USAGE;
    }

    out.heading(`Cannot uninstall from ${projectRoot}`);
    for (const entry of blocked) {
      out.line(`${entry.tool} is still needed by: ${entry.stillNeededBy.join(', ')}`);
    }
    out.line('');
    out.line('Removing it would leave those tools installed but broken.');
    out.line('');
    out.line('Options:');
    out.line('  uninstall the dependents first, then this tool');
    out.line('  utool uninstall ' + blocked.map((e) => e.tool).join(' ') + ' --force   (leaves them broken)');
    return EXIT.USAGE;
  }

  if (flags.json) {
    out.json({
      ok: plan.missingReceipts.length === 0,
      dryRun: Boolean(flags.dryRun),
      project: projectRoot,
      orphaned,
      ...plan,
    });
  } else {
    out.heading(`Uninstall from ${projectRoot}`);
    if (plan.missingReceipts.length > 0) {
      out.line(`no receipt for: ${plan.missingReceipts.join(', ')}`);
    }
    out.line(`${plan.delete.length} file(s) to remove, ${plan.keep.length} kept (shared).`);
    for (const file of plan.delete) out.line(`  remove  ${file}`);
    for (const entry of plan.keep) out.line(`  keep    ${entry.file} (claimed by ${entry.claimedBy.join(', ')})`);

    // Edited files are still removed, because the tool owns the directory it installed into. They
    // are listed first and separately, because a destructive action the user did not see coming is
    // a worse outcome than a slightly longer report.
    if (plan.modified.length > 0) {
      out.line('');
      out.line(`edited since install (${plan.modified.length}) - these WILL be removed:`);
      for (const entry of plan.modified) {
        out.line(`  edited  ${entry.file}`);
        out.line(`          installed ${entry.expected?.slice(0, 12) ?? '(unrecorded)'}...`);
        out.line(`          now       ${entry.actual.slice(0, 12)}...`);
      }
      out.line('');
      out.line('Someone changed these after they were installed. Uninstalling still removes them,');
      out.line('because everything under the paths this tool installed into belongs to the tool.');
      out.line('Reinstalling the tool restores the original bytes, so nothing here is unrecoverable.');
      out.line('To keep a change, move it outside the tool\'s directories first.');
    }
    if (plan.alreadyGone.length > 0) {
      out.line('');
      out.line('recorded but already absent from disk:');
      for (const file of plan.alreadyGone) out.line(`  missing ${file}`);
    }

    // The case this message exists for: the tool's folder was moved after it was installed.
    // Every recorded path is gone, so the uninstall removes nothing, and without this line the
    // only sign is a smaller number. The files are still in the project and the user has to
    // finish the job - so say where they were expected, not just that they are not there.
    if (plan.vanishedRoots.length > 0) {
      out.line('');
      out.line('the directory this tool was installed into is no longer where the receipt says:');
      for (const entry of plan.vanishedRoots) out.line(`  missing ${entry.root}  (${entry.toolId})`);
      out.line('It was moved or deleted outside this tool. Nothing is removed from a path this');
      out.line('receipt cannot prove it wrote, so delete that copy yourself, or reinstall into it');
      out.line('with --into once you have moved it back.');
    }
  }

  if (flags.dryRun) return EXIT.OK;
  if (plan.missingReceipts.length > 0) return EXIT.FAILURE;

  const outcome = await store.executeUninstall(plan, {
    projectRoot,
    receiptStore: store,
    toolIds: positionals,
  });

  if (inRecords(flags)) {
    // The plan, not just the outcome. A front end that only saw "0 files removed" could not tell
    // a clean uninstall from one whose files had already been moved away.
    rec.uninstallPlan(plan);
    for (const file of outcome.removed) rec.record('REMOVED', [file]);
    for (const directory of outcome.directories) rec.record('REMOVEDDIR', [directory]);
    for (const entry of outcome.failed) rec.record('PROBLEM', ['E-UNINSTALL-FILE', `${entry.file}: ${entry.reason}`]);
    for (const id of outcome.receipts) rec.record('RECEIPTREMOVED', [id]);
    rec.record('RESULT', [
      'removed', String(outcome.removed.length),
      'directories', String(outcome.directories.length),
      'failed', String(outcome.failed.length),
      'alreadyGone', String(outcome.alreadyGone.length),
      'modified', String(plan.modified.length),
      'movedRoots', String(plan.vanishedRoots.length),
    ]);
    return outcome.failed.length === 0 ? EXIT.OK : EXIT.FAILURE;
  }

  if (flags.json) {
    out.json({
      ok: outcome.failed.length === 0,
      project: projectRoot,
      ...outcome,
    });
  } else {
    out.heading(`Removed from ${projectRoot}`);
    out.line(
      `${outcome.removed.length} file(s) removed, ` +
      `${outcome.alreadyGone.length} already gone, ` +
      `${outcome.keep?.length ?? plan.keep.length} kept (shared).`,
    );
    for (const file of outcome.removed) out.line(`  removed  ${file}`);
    for (const directory of outcome.directories) out.line(`  rmdir    ${directory}`);
    for (const entry of outcome.failed) out.line(`  FAILED   ${entry.file}: ${entry.reason}`);
    if (outcome.receipts.length > 0) {
      out.line('');
      out.line(`receipt(s) cleared: ${outcome.receipts.join(', ')}`);
    }

    // Mention a dependency that nothing needs any more, without removing it. A tool
    // the user did not name should never disappear because of an uninstall they did
    // ask for; naming it here is enough for them to decide.
    if (orphaned.length > 0 && !flags.force) {
      out.line('');
      out.line(`no longer needed by anything installed: ${orphaned.join(', ')}`);
      out.line(`  remove with: utool uninstall ${orphaned.join(' ')}`);
    }
  }

  return outcome.failed.length === 0 ? EXIT.OK : EXIT.FAILURE;
}

async function cmdStatus({ flags }) {
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const store = new ReceiptStore(projectRoot);
  const receipts = await store.list();

  if (inRecords(flags)) {
    rec.receipts(receipts);
    return EXIT.OK;
  }

  if (flags.json) {
    out.json({
      ok: true,
      project: projectRoot,
      count: receipts.length,
      // Relationships, so they are visible BEFORE an uninstall is attempted rather
      // than only when one is refused.
      relationships: receipts.map((receipt) => ({
        toolId: receipt.toolId,
        neededBy: (receipt.installedByTools ?? []).filter((id) => id !== 'user'),
        dependsOn: receipt.dependencies ?? [],
      })),
      receipts,
    });
  } else {
    out.heading(`Installed in ${projectRoot}`);
    if (receipts.length === 0) {
      out.line('nothing installed.');
    } else {
      out.table(
        ['id', 'version', 'format', 'installed at', 'files'],
        receipts.map((receipt) => [
          receipt.toolId,
          receipt.version,
          receipt.artifactFormat,
          receipt.installedAtUtc,
          String((receipt.installedFiles ?? []).length),
        ]),
      );

      // Why each tool is here. A dependency pulled in automatically looks identical
      // to one the user chose in the table above, and that distinction decides
      // whether removing it is safe.
      const hasRelationships = receipts.some((receipt) =>
        (receipt.installedByTools ?? []).some((id) => id !== 'user'),
      );

      if (hasRelationships) {
        out.line('');
        out.line('why each tool is installed:');
        for (const receipt of receipts) {
          const by = (receipt.installedByTools ?? []).filter((id) => id !== 'user');
          out.line(
            by.length > 0
              ? `  ${receipt.toolId}  <- required by ${by.join(', ')}`
              : `  ${receipt.toolId}  <- you asked for it`,
          );
        }
      }
    }
  }
  return EXIT.OK;
}

async function cmdValidate({ registryLocator, flags }) {
  const root = path.resolve(registryLocator);
  const { containers } = await prepareAdapters(flags);
  const result = await validateRegistry(root, {
    containers,
    hash: !flags.noHash,
    onCheck: flags.quiet || flags.json ? undefined : (message) => out.line(`  ok  ${message}`),
  });

  if (flags.writeIndex) {
    if (result.errors.length > 0) {
      // Writing an index from a broken registry would only hide the problem.
      if (flags.json) out.json({ ok: false, errors: result.errors });
      else {
        out.line('');
        out.line(`refusing to write ${FILE_NAMES.INDEX}: the registry has ${result.errors.length} error(s)`);
        for (const error of result.errors) out.line(`  [${error.code}] ${error.message}`);
      }
      return EXIT.FAILURE;
    }
    const indexPath = path.join(root, FILE_NAMES.INDEX);
    let repository = null;
    if (existsSync(indexPath)) {
      try {
        const doc = loadUtool(indexPath);
        checkHeader(doc, indexPath, KIND.INDEX);
        repository = doc.repository ?? null;
      } catch {
        repository = null;
      }
    }
    await writeIndexFile(indexPath, buildIndex(result.manifests, repository));
    if (!flags.json) out.line(`\n${FILE_NAMES.INDEX} regenerated.`);
  }

  if (inRecords(flags)) {
    rec.validation(result);
    return result.ok ? EXIT.OK : EXIT.FAILURE;
  }

  if (flags.json) {
    out.json({
      ok: result.ok,
      registry: root,
      checks: result.checks,
      errors: result.errors,
      warnings: result.warnings,
    });
  } else {
    out.line('');
    if (result.ok) {
      out.line(`PASSED - ${result.checks} check(s), 0 errors`);
    } else {
      out.line(`FAILED - ${result.errors.length} error(s) out of ${result.checks} check(s):`);
      for (const error of result.errors) out.line(`  [${error.code}] ${error.message}`);
    }
  }
  return result.ok ? EXIT.OK : EXIT.FAILURE;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function buildPlan(source, requested, flags, adapters, host) {
  // Never write prose in records mode: stdout must stay machine-readable.
  if (!flags.quiet && !flags.json && !inRecords(flags)) {
    if (host) {
      out.line(`host: Unity ${host.unityVersion ?? '(unknown)'}, .NET ${host.dotNetVersion ?? '(unknown)'}`);
    } else {
      out.line('host: not declared, platform floors are not enforced (pass --host-unity/--host-dotnet)');
    }
  }

  // `--version <v>` pins the tool the user NAMED, leaving dependencies to resolve normally.
  // It is translated into the `id@version` form the resolver already understands rather
  // than adding a second pinning path: one mechanism means the documented
  // `utool plan my-tool@1.0.0` and the flag cannot drift apart.
  //
  // An id that already carries `@` wins, because it is the more specific request.
  if (typeof flags.version === 'string' && flags.version !== '') {
    requested = requested.map((id) =>
      id.includes('@') ? id : `${id}@${flags.version}`);
  }

  const index = await source.fetchIndex();
  const byId = new Map((index.tools ?? []).map((tool) => [tool.id, tool]));

  const fetchManifest = async (id) => {
    const summary = byId.get(id);
    if (!summary) {
      throw new UtoolError('E-DEP-MISSING', `no tool '${id}' in ${source.describe}`);
    }
    return toManifest(await source.fetchManifest(summary.manifestPath));
  };

  const engine = engineOf(flags);

  // Only engines whose adapter actually loaded can contribute a target. An
  // --also-engine without an adapter is not passed through as if it were
  // plannable: resolveSelection would then report every tool as unsupported,
  // which reads like a registry problem rather than a missing adapter.
  const alsoEngines = (flags.alsoEngine ?? []).filter((name) => adapters.has(name));

  const hostByEngine = {};
  if (host) {
    for (const [name, adapter] of adapters) hostByEngine[name] = adapter.hostFacts(host);
  }

  // Which tools advertise a capability, straight from the index, so the resolver
  // never has to hold a source or a full manifest set.
  const listProviders = async (capability) =>
    (index.tools ?? [])
      .filter((tool) => (tool.provides ?? []).includes(capability))
      .map((tool) => tool.id);

  return resolveSelection(requested, fetchManifest, {
    engine,
    alsoEngines,
    meetsRequirement: createRequirementChecker(adapters, hostByEngine),
    autoResolveInjects: Boolean(flags.autoProvider),
    listProviders,
  });
}

/** Which engine this run targets. Defaults to unity: it is the shipped adapter. */
function engineOf(flags) {
  return flags.engine ?? 'unity';
}

/**
 * Default registry location when nothing is given.
 *
 * Looked for rather than named, for the same reason the registry's own tooling searches for its
 * core: a directory name is not part of the contract. This default previously named
 * `UnityDevCommonLib`, which had been renamed to `ToolRegistry` commits earlier, so the
 * documented default pointed at a directory that no longer existed and every command without an
 * explicit --registry failed with a missing-index error that had nothing to do with the real cause.
 *
 * A candidate must hold BOTH index.yaml and payloads/. The index alone is not enough: the template
 * directory ships a skeleton index.yaml, and accepting it made `utool list` report the contents of
 * a template instead of the registry sitting right beside it.
 */
function isRegistry(dir) {
  return existsSync(path.join(dir, FILE_NAMES.INDEX))
    && existsSync(path.join(dir, 'payloads'));
}

/**
 * Directory names a registry checkout may have.
 *
 * `ToolRegistry` is current; `DevCatToolRegistry` is the former name and is still probed so a
 * checkout that has not been renamed keeps working. A directory name is not part of the
 * contract - that is why the search below also falls back to sniffing - but following a rename
 * by breaking every existing checkout would be a poor trade for tidiness.
 */
const REGISTRY_DIR_NAMES = ['ToolRegistry', 'DevCatToolRegistry'];

function findRegistry(cwd) {
  // The conventional names first, so a checkout is preferred over an unrelated directory that
  // happens to look like a registry.
  const roots = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')];
  for (const root of roots) {
    for (const name of REGISTRY_DIR_NAMES) {
      const conventional = path.join(root, name);
      if (isRegistry(conventional)) return conventional;
    }
  }

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (isRegistry(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Build the registry source, honouring mirror hosts.
 *
 * Mirrors are homogeneous: another host serving the same layout, chosen by the
 * caller rather than discovered. They are deliberately NOT read from index.yaml -
 * which host you can reach is a property of your network, not of the registry's
 * data, and a registry that could redirect its own readers could redirect them
 * anywhere. That is also why nothing is tried implicitly: an unreachable host is
 * reported, not quietly swapped for a different one the user never named.
 *
 * UTOOL_MIRROR exists for CI, where the environment is easier to set than every
 * command line. The flag wins when both are given, because an explicit argument
 * should not be silently extended by the environment.
 */
function sourceFor(registryLocator, flags) {
  const fromEnv = process.env.UTOOL_MIRROR
    ? process.env.UTOOL_MIRROR.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)
    : [];
  const mirrors = flags.mirror ?? fromEnv;

  return createSource(registryLocator, { ...(mirrors.length > 0 ? { mirrors } : {}) });
}

/**
 * Load the adapters this run needs.
 *
 * The core ships with no engine, so this is where Unity support actually comes
 * from. An engine with no adapter is still valid registry data; it simply cannot
 * be planned, and the loader says so by name.
 */
async function prepareAdapters(flags) {
  const primary = engineOf(flags);
  const extra = flags.alsoEngine ?? [];
  const engines = [...new Set([primary, ...extra])];

  // The PRIMARY engine's adapter is required: installing another engine's bytes
  // because the requested one is unsupported would be silently wrong. An EXTRA
  // engine is best-effort, because its target is an addition to the install rather
  // than the thing being asked for - but it must be reported, not dropped.
  const { containers, adapters, unavailable } = await loadAdapters(
    [primary],
    {},
  );
  const extras = await loadAdapters(extra, {
    onMissingAdapter: (engine, message) => {
      out.warn(`skipping --also-engine ${engine}: ${message}`);
    },
  });
  for (const [engine, adapter] of extras.adapters) adapters.set(engine, adapter);
  for (const [engine, message] of extras.unavailable) unavailable.set(engine, message);
  for (const format of extras.containers.formats()) {
    if (!containers.handles(format)) {
      containers.register(extras.containers.for(format));
    }
  }

  const host = flags.hostUnity || flags.hostDotnet ? detectHost(flags) : undefined;

  // Only engines with an adapter can contribute a target, so the list handed to the
  // resolver excludes the unavailable ones. Their targets are then reported as
  // "does not support <installed engines>" rather than silently ignored.
  const usable = engines.filter((engine) => adapters.has(engine));

  return { containers, adapters, engines: usable, skippedEngines: unavailable, host };
}

/**
 * Turn an artifact verification failure into a plan-shaped problem list.
 *
 * EVERY output mode must carry the REASON, and `--records` was the one that did not.
 * It wrote the failure as prose to stdout, so a records reader saw only
 * `PLAN tools 0 bytes 0 ok false` with no explanation and could report nothing better
 * than "Backend failed." -- which is exactly what the Unity window did when a payload
 * had been replaced by hand. The record stream is a contract: a reader that cannot see
 * WHY something failed cannot show a user anything actionable.
 */
async function safePlanInstallation(plan, source, containers, flags) {
  try {
    return await planInstallation(plan, source, containers, { into: flags.into ?? null });
  } catch (cause) {
    if (cause instanceof UtoolError) {
      if (inRecords(flags)) {
        rec.problems([{ code: cause.code ?? 'E-UNKNOWN', message: cause.message }]);
      } else if (flags.json) {
        out.json({ ok: false, error: cause.toJSON() });
      } else {
        out.line(`\nverification failed: [${cause.code}] ${cause.message}`);
      }
      return { tools: [], totalBytes: 0, ok: false };
    }
    throw cause;
  }
}

/**
 * Reject `--into` when it cannot mean one thing.
 *
 * A directory is a statement about ONE tool. With several ids there is no answer to "which of
 * these did you mean", and applying it to all of them would merge unrelated tools into one
 * folder - so it is refused before any work starts rather than guessed at.
 *
 * @returns {number|null} an exit code when the invocation is unusable
 */
function checkIntoScope(flags, positionals) {
  if (!flags.into) return null;
  if (positionals.length === 1) return null;

  const message =
    '--into needs exactly one tool id: it names the directory for the tool you asked for, ' +
    'and a dependency keeps the directory its own manifest declares.';
  if (inRecords(flags)) {
    rec.record('PROBLEM', ['E-INSTALL-INTO', message]);
    rec.record('RESULT', ['ok', 'false', 'exitCode', String(EXIT.USAGE)]);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return EXIT.USAGE;
}

function printPlan(plan, report, flags) {
  if (plan.providerChoices?.length > 0) {
    out.line('capability providers selected:');
    for (const choice of plan.providerChoices) {
      const alternatives = choice.alternatives.length
        ? ` (alternatives: ${choice.alternatives.join(', ')})`
        : '';
      out.line(`  ${choice.capability} -> ${choice.provider} for ${choice.neededBy}`);
    }
    out.line('');
  }
  if (plan.problems.length > 0) {
    out.line('problems:');
    for (const problem of plan.problems) out.line(`  [${problem.code}] ${problem.message}`);
    out.line('');
  }
  if (report.tools.length === 0) {
    out.line('nothing to do.');
    return;
  }
  out.table(
    ['id', 'version', 'engine', 'artifact', 'size', 'sha256', 'because of'],
    report.tools.map((tool) => [
      tool.id,
      tool.version,
      tool.engine,
      tool.artifactType + (tool.artifactFormat ? `/${tool.artifactFormat}` : ''),
      tool.size === null ? '-' : String(tool.size),
      tool.sha256 ? `${tool.sha256.slice(0, 12)}...` : '-',
      tool.installedBecause.join(', '),
    ]),
  );
  if (!flags.quiet) {
    for (const tool of report.tools) {
      if (tool.skipped) {
        out.line(`  note ${tool.id}/${tool.engine}: ${tool.skipped}`);
        continue;
      }
      // One line per engine, then what that engine would receive, so a
      // cross-engine tool does not blend two installs into one list.
      for (const item of tool.items) out.line(`    ${tool.id}/${tool.engine} -> ${item.path}`);
    }
  }
  out.line('');
  out.line(`${report.tools.length} tool(s), ${report.totalBytes} byte(s) of artifacts.`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? EXIT.OK;
  })
  .catch((error) => {
    // In records mode the failure must still be machine-readable, because the
    // Unity front end reads records rather than stderr.
    const recordsMode = process.argv.includes('--records');
    if (error instanceof UtoolError) {
      if (recordsMode) rec.failure(error);
      else process.stderr.write(`error: [${error.code}] ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    if (recordsMode) {
      rec.record('ERROR', ['E-UNEXPECTED', String(error?.message ?? error)]);
      rec.record('RESULT', ['ok', 'false', 'exitCode', String(EXIT.FAILURE)]);
    } else {
      process.stderr.write(`unexpected error: ${error?.stack ?? error}\n`);
    }
    process.exitCode = EXIT.FAILURE;
  });
