# Frontend architecture

Status: planned. This document fixes component boundaries before any code is written, so that each
piece can be built and tested on its own.

---

## Pipeline

```text
    RegistrySource            fetch or read index.json + tool.json
          |
          v
    ManifestCache             validated manifests, keyed by id
          |
          v
    DependencyResolver        required closure, version constraints, cycles, platform gate
          |
          v
    InstallPlanner            topological order -> InstallPlan (nothing written yet)
          |
          v
    [ UI review ]             user sees files, sizes, and why each tool is included
          |
          v
    ArtifactInstaller         fetch -> verify size+sha256 -> safe-extract -> import
          |
          v
    ReceiptStore              one receipt per tool under Library/
```

Every stage is pure except `ArtifactInstaller` and `ReceiptStore`. Resolution and planning must be
testable with no Editor window open and no network.

---

## Components

### `Registry/` — get the data

| Type | Responsibility |
| --- | --- |
| `IRegistrySource` | `FetchIndex()`, `FetchManifest(id)`, `FetchArtifact(path)`; abstracts HTTP, a local path, or a git checkout |
| `HttpRegistrySource` | `raw.githubusercontent.com` at a pinned ref, with a disk cache |
| `LocalPathRegistrySource` | points at a sibling `UnityDevCommonLib` checkout; used for development and tests |
| `ManifestParser` | JSON -> model; applies the rejection rules (unknown `schemaVersion`, id/directory mismatch) |

The source never mutates the registry. Read-only, cacheable by digest.

### `Resolution/` — decide what to install

| Type | Responsibility |
| --- | --- |
| `SemverLite` | parse `major.minor.patch[-pre]`; `Satisfies(version, constraint)` per SPEC §4.1 |
| `DependencyResolver` | required closure; optional deps only when already selected; cycle detection |
| `PlatformGate` | compare against `Application.unityVersion` and the project's API compatibility level |
| `ResolutionResult` | ordered tool set, or a structured error (unknown id, unsatisfiable constraint, cycle, platform mismatch) |

Errors are values, not exceptions, so the UI can present every problem at once instead of the first one.

### `Install/` — write to the project

| Type | Responsibility |
| --- | --- |
| `InstallPlanner` | `ResolutionResult` -> `InstallPlan` with a topological order and per-tool reasons |
| `ArtifactVerifier` | size, `sha256`, container magic, zip-slip/tar-slip rejection |
| `UnitypackageImporter` | parse the gzipped tar, read each GUID folder's `asset`, `asset.meta`, `pathname` |
| `ZipExtractor` | extract into `install.contentRoot` |
| `ReceiptStore` | read/write/query receipts; drives exact uninstall |
| `Uninstaller` | reference-counts shared files; never deletes a file another receipt claims |

`ArtifactVerifier` runs **first** for the whole plan. If any step fails verification, nothing is
written — a partial install is worse than no install.

### `UI/` — the selection window

- list from `index.json`, grouped by `type`, filterable by `tags`, searchable by name/description;
- a detail pane showing `version`, floors, `dependencies` (with each dependency's `reason`), and `files`;
- incompatible tools visibly disabled with the reason, not hidden;
- a confirmation step rendering the `InstallPlan` before anything is written;
- an installed-tools view driven by receipts, with per-tool uninstall.

---

## Decisions already made

| Decision | Rationale |
| --- | --- |
| Registry is read-only data; the frontend owns all writes | Keeps "no pollution" enforceable in one place |
| Verify the entire plan before writing anything | Avoids half-installed states that are hard to describe to a user |
| Receipts under `Library/` | Unity never commits `Library/`, so local state cannot leak into a consumer's VCS |
| Errors as values, not exceptions | The UI must show all resolution problems, not just the first |
| `LocalPathRegistrySource` first | Develop and test against the sibling registry with no network |

See also [`../UnityDevCommonLib/docs/FRONTEND-INTEGRATION.md`](../../UnityDevCommonLib/docs/FRONTEND-INTEGRATION.md)
for the normative data contract, and [`decisions.md`](decisions.md) for the reasoning behind the
frontend living in a separate directory.
