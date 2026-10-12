/**
 * Output helpers.
 *
 * Two audiences share this CLI: humans reading a terminal, and the Unity front
 * end parsing stdout. JSON mode must therefore emit exactly one JSON document
 * and nothing else on stdout, so `out.json` is the only writer used in that mode.
 */

const useColor =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';

const wrap = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));

const bold = wrap('1');
const dim = wrap('2');

/** @param {string} message */
export function line(message = '') {
  process.stdout.write(`${message}\n`);
}

/** @param {string} message */
export function heading(message) {
  line(bold(message));
}

/**
 * @param {string} label
 * @param {string} value
 */
export function field(label, value) {
  line(`  ${label.padEnd(14)} ${value ?? '-'}`);
}

/**
 * Render a simple aligned table. Column widths come from the content, which is
 * enough here: the registry lists are short.
 *
 * @param {string[]} headers
 * @param {(string|number|null|undefined)[][]} rows
 */
export function table(headers, rows) {
  const cells = rows.map((row) => row.map((value) => (value === null || value === undefined ? '-' : String(value))));
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => (row[i] ?? '').length), 0),
  );

  const renderRow = (row, style) =>
    row
      .map((value, i) => (i === row.length - 1 ? value : value.padEnd(widths[i])))
      .join('  ')
      .replace(/\s+$/, '');

  line(renderRow(headers.map((h, i) => h.padEnd(widths[i])), (t) => t));
  line(headers.map((_, i) => '-'.repeat(widths[i])).join('  '));
  for (const row of cells) {
    line(renderRow(row));
  }
}

/** @param {unknown} value */
export function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} message
 */
export function warn(message) {
  process.stderr.write(`${dim(`warning: ${message}`)}\n`);
}
