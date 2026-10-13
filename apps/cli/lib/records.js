/**
 * Line-oriented output for embedders.
 *
 * The Unity front end needs structured data but should not embed a JSON parser,
 * and UnityEngine.JsonUtility cannot deserialise a root-level array. So the CLI
 * offers a third output mode: one record per line, TAB separated, with a record
 * type as the first field. Parsing is then a split, and a malformed line is
 * obvious rather than a silent no-op.
 *
 * Field values escape TAB, CR and LF so a record is always exactly one line.
 * Every record type is documented in the CLI's --help text.
 */

/** @param {unknown} value @returns {string} */
export function escapeField(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Write one record.
 *
 * @param {string} type record type, e.g. TOOL
 * @param {(string|number|boolean|null|undefined)[]} fields
 */
export function record(type, fields = []) {
  process.stdout.write(`${[type, ...fields.map(escapeField)].join('\t')}\n`);
}

/**
 * @param {string} registry
 */
export function meta(registry) {
  record('META', ['registry', registry]);
}

/**
 * @param {Array<Record<string, any>>} tools
 */
export function toolSummaries(tools) {
  for (const tool of tools) {
    // The index carries `latest` plus every published version, not a single `version`,
    // because a consumer may now choose one. VERSIONS is a separate record so the TOOL
    // field order stays stable for older front ends.
    const latest = tool.latest ?? tool.version ?? '';
    record('TOOL', [
      tool.id,
      latest,
      tool.type,
      (tool.engines ?? []).join(','),
      (tool.provides ?? []).join(','),
      (tool.injects ?? []).join(','),
      tool.displayName,
      (tool.tags ?? []).join(','),
      (tool.dependencies ?? []).map((dep) => `${dep.id}${dep.version ? `@${dep.version}` : ''}`).join(','),
      tool.manifestPath ?? '',
    ]);
    for (const version of tool.versions ?? []) {
      record('VERSIONS', [tool.id, version, version === latest ? 'latest' : '']);
    }
  }
}

/**
 * Per-engine detail: one TARGET record per engine the tool declares.
 *
 * Engine-specific data is reported per target rather than flattened into DETAIL,
 * because a cross-engine tool has several sets of floors and artifacts and
 * flattening them would lose which belongs to which engine.
 *
 * @param {import('../../packages/utool-core/src/manifest.js').ToolTarget[]} targets
 */
export function toolTargets(targets) {
  for (const target of targets) {
    record('TARGET', [
      target.engine,
      target.minEngineVersion,
      Object.entries(target.extraRequirements)
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
      target.type,
      target.format ?? '',
      target.artifactPath ?? '',
      target.contentRoot ?? '',
      target.targetPath ?? '',
      target.editorOnly ? 'true' : 'false',
      target.external?.url ?? '',
      target.external?.ref ?? '',
    ]);
  }
}

/**
 * @param {Record<string, any>} manifest a raw .yaml document
 * @param {import('../../packages/utool-core/src/manifest.js').ToolManifest} [model]
 */
export function toolDetail(manifest, model) {
  record('DETAIL', ['id', manifest.id]);
  record('DETAIL', ['displayName', manifest.displayName]);
  record('DETAIL', ['type', manifest.type]);
  record('DETAIL', ['version', manifest.version]);
  record('DETAIL', ['description', manifest.description]);
  record('DETAIL', ['engines', (model?.engines ?? Object.keys(manifest.targets ?? {})).join(',')]);
  record('DETAIL', ['provides', (manifest.provides ?? []).join(',')]);
  record('DETAIL', ['injects', (manifest.injects ?? []).join(',')]);
  record('DETAIL', ['license', manifest.license]);
  record('DETAIL', ['author', manifest.author]);
  record('DETAIL', ['homepage', manifest.homepage]);
  record('DETAIL', ['deprecated', manifest.deprecated === true ? 'true' : 'false']);

  for (const dep of manifest.dependencies ?? []) {
    record('DEPENDENCY', [
      dep.id,
      dep.version ?? '',
      dep.optional ? 'optional' : 'required',
      dep.reason ?? '',
      (dep.engines ?? []).join(','),
    ]);
  }
  for (const file of manifest.files ?? []) {
    record('WILLINSTALL', [file]);
  }
}

/**
 * Capability providers the resolver chose on the caller's behalf.
 *
 * Reported separately from the plan because a user needs to see that a tool was
 * added for a capability rather than because they asked for it, and what else could
 * have satisfied it.
 *
 * @param {{capability: string, provider: string, neededBy: string, alternatives: string[]}[]} choices
 */
export function providerChoices(choices = []) {
  for (const choice of choices) {
    record('PROVIDER', [
      choice.capability,
      choice.provider,
      choice.neededBy,
      (choice.alternatives ?? []).join(','),
    ]);
  }
}

/**
 * @param {{code: string, message: string}[]} problems
 */
export function problems(problems) {
  for (const problem of problems) {
    record('PROBLEM', [problem.code, problem.message]);
  }
}

/**
 * @param {import('../../packages/utool-core/src/install.js').InstallPlanReport} report
 * @param {{dryRun?: boolean}} [options]
 */
export function installPlan(report, options = {}) {
  for (const tool of report.tools) {
    record('PLANTOOL', [
      tool.id,
      tool.version,
      tool.engine,
      tool.artifactType ?? '',
      tool.artifactFormat ?? '',
      tool.size ?? '',
      tool.sha256 ?? '',
      tool.contentRoot ?? '',
      tool.editorOnly ? 'true' : 'false',
      tool.installedBecause.join(','),
      tool.skipped ?? '',
    ]);
    for (const item of tool.items) {
      // Directory records carry no bytes and are not files to report.
      if (item.path) record('PLANFILE', [tool.id, item.path]);
    }
  }
  record('PLAN', [
    'tools', String(report.tools.length),
    'bytes', String(report.totalBytes),
    'ok', report.ok ? 'true' : 'false',
    'dryRun', options.dryRun ? 'true' : 'false',
  ]);
}

/**
 * @param {{installed: {id: string, files: string[]}[], skipped: {id: string, reason: string}[], bytes: number}} outcome
 */
export function installResult(outcome) {
  for (const item of outcome.installed) {
    record('INSTALLED', [item.id, String(item.files.length)]);
    for (const file of item.files) {
      record('INSTALLEDFILE', [item.id, file]);
    }
  }
  for (const item of outcome.skipped) {
    record('SKIPPED', [item.id, item.reason]);
  }
  record('RESULT', ['installed', String(outcome.installed.length), 'bytes', String(outcome.bytes)]);
}

/**
 * @param {Record<string, any>[]} receipts
 */
export function receipts(receipts) {
  for (const receipt of receipts) {
    record('RECEIPT', [
      receipt.toolId,
      receipt.version,
      receipt.artifactFormat,
      receipt.installedAtUtc,
      String((receipt.installedFiles ?? []).length),
      (receipt.installedFiles ?? []).join(','),
    ]);
  }
  record('RESULT', ['installed', String(receipts.length)]);
}

/**
 * @param {import('../../packages/utool-core/src/registry.js').ValidationResult} result
 */
export function validation(result) {
  for (const error of result.errors) {
    record('PROBLEM', [error.code, error.message]);
  }
  for (const warning of result.warnings) {
    record('WARNING', [warning.code, warning.message]);
  }
  record('RESULT', [
    'ok', result.ok ? 'true' : 'false',
    'checks', String(result.checks),
    'errors', String(result.errors.length),
  ]);
}

/**
 * @param {import('../../packages/utool-core/src/errors.js').UtoolError} error
 */
export function failure(error) {
  record('ERROR', [error.code ?? 'E-UNKNOWN', error.message]);
  record('RESULT', ['ok', 'false', 'exitCode', String(error.exitCode ?? 1)]);
}
