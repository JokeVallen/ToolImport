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
