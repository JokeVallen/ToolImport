# Changelog

All notable changes to the import tool are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
of the tool are its own; the metadata format it reads is versioned separately by
`formatVersion`, documented in
[`../ToolRegistry/docs/SPEC.en.md`](../ToolRegistry/docs/SPEC.en.md).

**Language**: [English](CHANGELOG.en.md) · [中文](CHANGELOG.zh-CN.md) · [back to index](README.md)

## [Unreleased]

### About this file

The work below happened in one continuous push that built the tool and moved the
metadata format to `formatVersion 2` at the same time, so the entries are grouped by
area rather than by release date. Nothing here has been published.

## Install destination, and what a moved tool looks like

### Added

- **`install --into <dir>`** — install the tool you asked for into a project directory of your
  choice instead of the one its manifest declares. The manifest's destinations are the default,
  not a command: the tool's directory is derived from where its files actually land, and the
  override replaces that root while keeping the structure below it. A dependency keeps its own
  layout, so `--into` requires exactly one id.
- **`Install into` in the Unity window** — the same choice, above the action buttons, empty
  meaning "as the manifest declares" with the default named underneath. The plan is cleared when
  it changes, because a plan for the old destination describes files that will not be written.
- **`installedRoots` in receipts** — the directory each engine's payload occupies. It is the one
  thing a receipt can say about a tool whose files have gone.
- **`MOVEDROOT` / `ALREADYGONE` records** and a matching status line: an uninstall whose recorded
  paths are all missing now names the directory that is no longer there, instead of reporting
  "0 file(s) removed" as if it had worked.
- `PLANTOOL` gained trailing `installRoot` and `into` fields; `PLANFILE` now reports the
  destination that will exist on disk rather than the path inside the archive.

### Fixed

- An artifact whose `contentRoot` contains `..` is refused at plan time. Entry names were checked
  before, but the declared root was glued in front of them afterwards, so the check ran on the
  wrong string.
- `--into` with an absolute path or a drive letter is refused before anything is downloaded;
  a leading `/` used to be silently stripped into a relative directory.

## Choosing a version, and a destination that explains itself

### Added

- **A placeholder, and a plain statement of the rules, on `Install into`.** The field was blank
  and silent: nothing said whether the value is project-relative or absolute, and nothing said
  what happens to the folder the tool already occupies. Empty now reads "empty: as declared,
  under Assets", and the line below says that the value is project-relative, that absolute paths
  and `..` are refused, and that it REPLACES the tool's own directory - the files inside keep
  their layout, so `Assets/IMGUILib/Core/x.cs` becomes `<your folder>/Core/x.cs`. The same
  explanation is in both READMEs.
- **A separator between the detail links.** "Homepage Documentation Release notes MIT" drawn as
  four adjacent buttons read as one phrase; a middot now marks where each destination ends.

### Fixed

- **`plan` failed for every tool with a multi-version dependency**, reporting
  `versionsRequested is not defined`. That name is a local of `resolveSelection`, but the
  function narrowing a dependency's version is module-level and read it as if it were in scope.
  It is now passed in. `editor-coroutines-lit` was the tool that hit it, because it constrains
  two libraries that publish more than one release. The resolver had no test at all; it has four
  now, covering the constraint, the intersection of two consumers, an unsatisfiable constraint,
  and an explicit `id@version`.
- **Choosing a release showed the other one.** Picking 0.9.0 displayed 1.0.0, and picking 1.0.0
  displayed 0.9.0. Two defects in the same place: a backend call made while another was running
  was dropped outright (so the pin moved but the pane was never re-read), and the single waiting
  slot kept the FIRST request even though its own comment claimed it kept the newest. Requests
  now queue, and the newest one replaces the waiting one.

## The declared inventory reaches the editor again

### Fixed

- **`Installs N file(s)` was permanently empty in the Unity window.** The CLI reported the
  inventory from the top-level `files` field, which `formatVersion 3` moved onto
  `versions[].targets.<engine>.artifact.files`. Nothing failed: the reader yielded no records and
  the section simply never drew. `WILLINSTALL` now carries the file in field 0 and its engine in a
  trailing field, and the window shows only the engine it installs into - so a cross-engine tool no
  longer suggests its Godot payload is about to land in `Assets`.
- **`utool show <id>` exited 1 for every tool.** The trailing `installs:` block read the same
  moved field off a typed model with no such getter, so it threw after printing the description.
  The inventory is now listed under the target it belongs to, and an end-to-end test runs `show`
  for every tool in the registry.

## Tool built, format v2

### Added

- `packages/utool-core` — the engine-neutral core: `.yaml` document loading, a
  draft-07 JSON Schema subset, registry validation, dependency and capability
  resolution, artifact verification, install planning and execution, and receipts.
- A **container registry** so the core never learns an engine name. The core registers
  handlers for `zip`, `tgz`, `tar.gz`, `tar.zst` and single-file payloads; an engine
  adapter registers the formats it owns. Registering two handlers for one format is an
  error rather than a silent win.
- Container handler contract — `inspect(bytes, artifact, ctx)` reports destinations
  without writing, `extract(bytes, artifact, ctx)` writes. Both share one item reader,
  so the verified file list and the written file list cannot disagree.
- A **write context** owning path resolution: it applies `contentRoot` and refuses
  anything outside the project root, so a handler cannot decide paths itself.
- `providers/engine-unity` — the `unitypackage` container plus Unity version and .NET
  API level comparison.
- `providers/engine-godot` — Godot version comparison, and deliberately **no** container
  handler, because Godot addons are ordinary archives the core already opens.
- Three-valued requirement comparison: an adapter returns `true`, `false`, or
  `undefined` for "this adapter cannot judge that key". The core reports an unjudged
  floor without enforcing it.
- `apps/cli` — `utool` with `list`, `show`, `plan`, `verify`, `install`, `uninstall`,
  `rollback`, `status` and `validate`; exit codes 0/1/2/3/4 shared by CI and the front
  end; three output modes: prose, `--json`, and `--records`.
- `frontends/unity-editor` — a Unity window that contains no format logic: it runs the
  CLI and renders records. Engine selector in the toolbar; per-target detail panes that
  print requirement keys verbatim rather than hard-coding Unity's.
- `tools/csharp-check.mjs` — type-checks the real C# front end against minimal Unity
  stubs, so a C# error surfaces in about a second with no Unity installed.
- Receipts with a **version pointer**: `previousSha256` records what an install
  replaced, `planRollback` reports the digest to restore, `clearRollback` retires the
  pointer once used, and `utool rollback` surfaces it.
- Capability provider selection: `--auto-provider` lets the resolver satisfy an
  `injects` entry by choosing a provider deterministically (lowest id wins) and
  reporting the alternatives. Off by default, because silently adding a tool the user
  did not ask for is worse than explaining the gap.
- Tests for the core and the CLI: document parsing, semver-lite constraints, registry
  validation, dependency and capability resolution, artifact verification, install with
  receipts, the rollback pointer, shared-file reference counting, and argument parsing.
  The core suite validates the **real** registry in `../ToolRegistry`.

### Changed

- `--records` gained a `TARGET` record and a `PROVIDER` record, and `TOOL` / `PLANTOOL`
  changed shape, because engine-specific data cannot be flattened for a cross-engine
  tool without losing which engine it belongs to.
- The Unity front end moved from `apps/unity-editor` to `frontends/unity-editor`, so the
  layout reads as one directory per engine on each side of the seam.
- The root workspace name was corrected from `unitydevcommonlib-import-tool` to
  `toolimport` after the repository rename.

### Fixed

- **`--also-engine godot` was parsed as `--also-engine g`.** The flag did not take a
  value, so the next token became a positional and the engine name lost its first
  character; the failure surfaced later as `no adapter for engine 'g'`. Repeatable
  value flags are now their own category and accumulate.
- **A receipt recorded archive-relative paths instead of where files land.** Without a
  `contentRoot` the two are identical, so nothing noticed; with one, the Godot files
  were recorded as `plugin.cfg` while living at `addons/core_utils/plugin.cfg`, so
  uninstall would have searched the wrong place and left residue. Every unit test passed
  while this was broken, because they tested the archive reader rather than the receipt.
- A **missing adapter for an `--also-engine`** killed the whole run. The primary
  engine's adapter is still required, because substituting another engine's bytes would
  be wrong; an extra engine is now a warning and a skip, so the requested install
  completes.
- `printPlan` still iterated the v1 `tool.files` field, so every `utool install` threw
  `TypeError: tool.files is not iterable` after printing a plan that looked correct and
  before writing anything.
- An informational `host:` line was written to stdout in `--records` mode, corrupting
  the stream the Unity front end parses.
- The C# front end had three stale field references and had never been compiled; the
  type-check harness above was added to make that class of staleness impossible to ship
  unnoticed.

### Known limitations

- **The C# front end has never been run inside a real Unity editor.** It compiles with
  zero errors and warnings, and its API calls were checked against Unity's signatures,
  but its runtime behaviour is unverified.
- **Uninstall execution is not enabled.** The exact plan and the reference counting are
  implemented and tested; deleting files is deliberately the last thing to switch on.
- **Rollback only plans.** The registry publishes one version per tool, so the bytes a
  tool replaced are normally no longer published; naming the digest that must be
  re-published is the honest behaviour.
- **External sources are not resolved.** The backend reports an `external` target as
  caller-resolved rather than shelling out to git.
