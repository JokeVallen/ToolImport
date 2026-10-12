/**
 * Host capability detection.
 *
 * Platform floors are only enforced when the host is known. The CLI cannot read
 * a Unity project's version by itself, so the caller declares it (the Unity front
 * end knows both values exactly and passes them in). Detection here is limited to
 * reading ProjectSettings/ProjectVersion.txt when a project directory is nearby,
 * which is enough to be useful from a plain shell.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read the editor version from ProjectSettings/ProjectVersion.txt.
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function readProjectUnityVersion(projectRoot) {
  const file = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const match = /^m_EditorVersion:\s*(\S+)/m.exec(text);
  return match ? match[1] : null;
}

/**
 * Determine host capabilities from flags, then from the project, then unknown.
 *
 * @param {{hostUnity?: string, hostDotnet?: string, project?: string}} flags
 * @returns {{unityVersion: string|null, dotNetVersion: string|null}}
 */
export function detectHost(flags = {}) {
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  return {
    unityVersion: flags.hostUnity ?? readProjectUnityVersion(projectRoot),
    dotNetVersion: flags.hostDotnet ?? null,
  };
}
