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
 * Read the engine version from a Godot project file.
 *
 * `config/features=PackedStringArray("4.2", "GL Compatibility")` is the only place a Godot
 * project states which editor wrote it. Taking the first feature entry that looks like a
 * version is deliberate: the rest of the array is renderer and platform hints.
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function readProjectGodotVersion(projectRoot) {
  const file = path.join(projectRoot, 'project.godot');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const line = /^config\/features\s*=\s*(.+)$/m.exec(text);
  if (!line) return null;
  const quoted = line[1].match(/"(\d+(?:\.\d+)*)"/);
  return quoted ? quoted[1] : null;
}

/**
 * Determine host capabilities from flags, then from the project, then unknown.
 *
 * @param {{hostUnity?: string, hostDotnet?: string, hostGodot?: string, project?: string}} flags
 * @returns {{unityVersion: string|null, dotNetVersion: string|null, godotVersion: string|null}}
 */
export function detectHost(flags = {}) {
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  return {
    unityVersion: flags.hostUnity ?? readProjectUnityVersion(projectRoot),
    dotNetVersion: flags.hostDotnet ?? null,
    // Godot puts its version in the project file rather than in a settings document, so a
    // project on disk can answer this without the caller naming it.
    godotVersion: flags.hostGodot ?? readProjectGodotVersion(projectRoot),
  };
}
