/**
 * Public surface of the import-tool core.
 *
 * This package has NO engine dependency by design: an engine contributes a
 * container handler and a requirement comparator through its adapter, and the core
 * never learns the engine's name. The CLI, the Unity front end and CI all consume
 * exactly this API, so the rules live in one place and can be tested with no
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
  ARTIFACT_TYPE,
  KNOWN_ARTIFACT_TYPES,
  CORE_ARCHIVE_FORMATS,
  ARCHIVE_MAGIC,
  FORMAT_EXTENSION,
  UNPACK,
  RECEIPT_DIR,
  ID_PATTERN,
  ENGINE_ID_PATTERN,
  CAPABILITY_PATTERN,
  ARTIFACT_PATH_PARTS_PATTERN,
  ARTIFACT_NAME_PATTERN,
  isCapability,
  expectedArtifactName,
  artifactNameEngine,
} from './format.js';

export { parseUtool, loadUtool, checkHeader, loadKind } from './loader.js';
export { SchemaValidator } from './schema.js';
export { ToolManifest, ToolTarget, toManifest } from './manifest.js';
export {
  LocalRegistrySource,
  HttpRegistrySource,
  MirroredRegistrySource,
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

export {
  resolveSelection,
  exitCodeFor,
  pickHighestSatisfying,
  DEFAULT_ENGINE,
} from './resolver.js';

export {
  ContainerRegistry,
  createCoreContainerRegistry,
  fileHandler,
  ZSTD_MIN_NODE,
} from './containers.js';

export {
  hashFile,
  detectCoreArchiveFormat,
  isSafeEntryName,
  assertSafePaths,
  assertInstallDirectory,
  commonDirectory,
  relocatedPath,
  verifyArtifactBytes,
  verifyArtifactFile,
} from './artifacts.js';

export { planInstallation, executeInstall } from './install.js';
export { ReceiptStore } from './receipts.js';
export { validateRegistry, buildIndex } from './registry.js';
