/**
 * Public surface of the UnityDevCommonLib import-tool core.
 *
 * This package has no Unity dependency by design (docs/decisions.md D-1a in the
 * frontend repository): the Unity editor front end, the CLI and CI all consume
 * exactly this API, so the rules live in one place and can be tested without an
 * editor running.
 */

export {
  EXIT,
  UtoolError,
  DocumentError,
  ResolutionError,
  PlatformError,
  ArtifactError,
  DiagnosticBag,
} from './errors.js';

export {
  FORMAT_VERSION,
  KIND,
  KNOWN_KINDS,
  FILE_NAMES,
  ALLOWED_PAYLOAD_ENTRIES,
  TOOL_TYPES,
  SOURCE_KIND,
  SOURCE_TYPE,
  ARTIFACT_FORMAT,
  KNOWN_ARTIFACT_FORMATS,
  MAGIC,
  RECEIPT_DIR,
  ID_PATTERN,
  ARTIFACT_FORMAT_PATTERN,
  ARTIFACT_PATH_PARTS_PATTERN,
  isConformingArtifactName,
} from './format.js';

export { parseUtool, loadUtool, checkHeader, loadKind } from './loader.js';
export { SchemaValidator } from './schema.js';
export { ToolManifest, toManifest } from './manifest.js';
export {
  LocalRegistrySource,
  HttpRegistrySource,
  createSource,
} from './source.js';

export {
  parseVersion,
  compareVersions,
  satisfies,
  isVersion,
  isConstraint,
  parseUnityVersion,
  compareUnityVersions,
  compareDotNetVersions,
} from './semver.js';

export { resolveSelection, checkPlatform, exitCodeFor } from './resolver.js';

export {
  hashFile,
  detectFormat,
  listTarEntries,
  listZipEntries,
  isSafeEntry,
  verifyArtifactBytes,
  verifyArtifactFile,
  inspectUnitypackage,
  readUnitypackagePathnames,
} from './artifacts.js';

export { readCentralDirectory, readEntry, readAllEntries } from './zip.js';

export {
  planInstallation,
  executeInstall,
  extractUnitypackage,
  extractZip,
} from './install.js';

export { ReceiptStore } from './receipts.js';
export { validateRegistry, buildIndex } from './registry.js';
