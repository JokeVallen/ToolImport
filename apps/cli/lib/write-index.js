/**
 * Write index.utool.
 *
 * The file is generated, so it is written with the same style as the Python
 * generator in the registry repository: a short header explaining that it must
 * not be hand-edited, then the YAML document. `lineWidth: 0` keeps long artifact
 * paths on one line, which is what makes the file readable in a diff.
 */

import { writeFile } from 'node:fs/promises';

import { stringify as stringifyYaml } from 'yaml';

const HEADER = `# index.utool -- generated catalog of every tool in this registry.
#
# Do not hand-edit. Regenerate with:
#     utool validate --write-index
#     python tools/validate_registry.py . --write-index
#
# Entries here are summaries so the import tool can list everything in one
# request. The authoritative record for any tool is its own
# payloads/<id>/tool.utool, which is what gets read before an install.
`;

/**
 * @param {string} indexPath absolute path of index.utool
 * @param {Record<string, unknown>} index document to serialise
 */
export async function writeIndexFile(indexPath, index) {
  const body = stringifyYaml(index, { lineWidth: 0, indent: 2 });
  await writeFile(indexPath, `${HEADER}\n${body}`, 'utf8');
}
