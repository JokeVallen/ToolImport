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
    record('TOOL', [
      tool.id,
      tool.version,
      tool.type,
      tool.sourceKind,
      tool.minUnityVersion,
      tool.minDotNetVersion,
      tool.displayName,
      (tool.tags ?? []).join(','),
      (tool.dependencies ?? []).map((dep) => `${dep.id}${dep.version ? `@${dep.version}` : ''}`).join(','),
      tool.artifactPath ?? '',
    ]);
  }
}

/**
 * @param {Record<string, any>} manifest a raw .utool document
 */
export function toolDetail(manifest) {
  const source = manifest.source ?? {};
  record('DETAIL', ['id', manifest.id]);
  record('DETAIL', ['displayName', manifest.displayName]);
  record('DETAIL', ['type', manifest.type]);
  record('DETAIL', ['version', manifest.version]);
  record('DETAIL', ['description', manifest.description]);
  record('DETAIL', ['minUnityVersion', manifest.minUnityVersion]);
  record('DETAIL', ['minDotNetVersion', manifest.minDotNetVersion]);
  record('DETAIL', ['sourceKind', source.kind]);
  record('DETAIL', ['sourceType', source.type]);
  record('DETAIL', ['artifactPath', source.artifactPath]);
  record('DETAIL', ['artifactFormat', source.artifactFormat]);
  record('DETAIL', ['gitUrl', source.url]);
  record('DETAIL', ['gitRef', source.ref]);
  record('DETAIL', ['license', manifest.license]);
  record('DETAIL', ['author', manifest.author]);
  record('DETAIL', ['deprecated', manifest.deprecated === true ? 'true' : 'false']);

  for (const dep of manifest.dependencies ?? []) {
    record('DEPENDENCY', [dep.id, dep.version ?? '', dep.optional ? 'optional' : 'required', dep.reason ?? '']);
  }
  for (const file of manifest.files ?? []) {
    record('WILLINSTALL', [file]);
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
      tool.sourceKind,
      tool.size ?? '',
      tool.sha256 ?? '',
      tool.artifactFormat ?? '',
      tool.contentRoot ?? '',
      tool.editorOnly ? 'true' : 'false',
      tool.installedBecause.join(','),
      tool.skipped ?? '',
    ]);
    for (const file of tool.files) {
      // Folder entries carry no bytes and are excluded from the file list
      // upstream, so every entry here is a real destination.
      if (file.path) record('PLANFILE', [tool.id, file.path]);
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
