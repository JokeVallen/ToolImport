# Changelog

All notable changes to the import tool are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
of the tool are its own; the metadata format it reads is versioned separately by
`formatVersion`, documented in
[`../ToolRegistry/docs/SPEC.en.md`](../ToolRegistry/docs/SPEC.en.md).

**Language**: [English](CHANGELOG.en.md) · [中文](CHANGELOG.zh-CN.md) · [back to index](README.md)

## [1.1.0] — 2026-10-23

### Changed

- **The Godot front end is a floating window opened from Project > Tools**, not a dock. It is the
  same shape as the Unity one - a menu entry, a window, a Settings window - because moving between
  the two editors should not mean learning two designs.
- **Configuration moved out of the main window.** A Settings window holds the registry, the CLI and
  the Node executable, and shows what the three values currently RESOLVE to: an empty field means
  "the automatic one", and only the resolved value says which one that is.
- **Resolution order now matches Unity exactly**: the settings window, then `UTOOL_REGISTRY` /
  `UTOOL_CLI` / `UTOOL_NODE`, then a sibling checkout found by walking up from the project, then the
  published registry URL or `node` on PATH. A workspace with the checkouts side by side needs no
  configuration at all.
- **A first run with no CLI found opens Settings by itself**, instead of leaving a message the user
  has no way to act on.
- The toolbar is Unity's: registry leaf name (full value on hover), Refresh, Settings, search.

### Fixed

- **The plan block no longer runs to the bottom of the window.** It is as tall as its lines up to a
  cap, then scrolls itself; a forty-file plan used to push the verified / not-verified line out of
  sight.

## [1.0.2] — 2026-10-23

### Fixed

- **Every command came back empty.** `OS.execute` returns one array element per line on some
  platforms and the entire output as a single element on others; on Windows it was the latter, so
  `list --records` arrived as one "record" with 91 fields and no `TOOL` among them. The parser now
  splits inside each element too, which is correct for both shapes and costs nothing when the
  chunks are already single lines.
- **A verified plan was reported as not verified.** The `ok` flag lives in the `PLAN` record
  (`PLAN tools 1 bytes 1047 ok true dryRun false`), not in `RESULT`, and only `RESULT` was read.
- **Half of the pane was translated and half was not.** Godot 4.4+ translates a Control's text
  through the editor's own catalogue: `Node` was shown as its Chinese word and `Install` as its
  Chinese word while `Registry` stayed English. Translation is now off for these controls (and the
  call is guarded, so older 4.x - which does not translate them - is unaffected).

### Changed

- **The three path fields fill the pane and each has a picker.** Typing a Windows path by hand was
  the step a first run got wrong, and the fields were too narrow to read what had been typed.
- **An empty tool list says why**: no paths yet, or no tool in this registry that supports Godot.

## [1.0.1] — 2026-10-23

### Fixed

- **The Godot addon did not compile.** `EditorSettings.get_setting(key, default)` takes one
  argument, and several `:=` declarations had no type to infer from (the element of an untyped
  array is a `Variant`). Both were written on a machine with no Godot, so nothing could have
  caught them before a user opened the editor and read the parse errors. `Backend.of()` now
  returns a typed array, which is what the loops needed, and settings are read through one
  wrapper that knows the real signature.

### Added

- **`npm run check:godot`** compiles the addon with a real Godot and then loads the editor with
  the plugin enabled. It finds the binary automatically (or takes `--godot` / `GODOT_BIN`) and
  skips with a message when none is installed. This is the missing compiler, not a nicety: the
  front end had no way to be checked at all, which is why 1.0.0 shipped broken.

## [1.0.0] — 2026-10-23

### About this file

This is the first release. The work below happened in one continuous push that built the tool
and moved the metadata format to `formatVersion 2` (and then 3) at the same time, so the entries
are grouped by area rather than by release date, and everything listed here ships in `1.0.0`.

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

## The details pane, item by item

### Changed

- **The plan scrolls sideways.** Long destinations were clipped, and the file name is the end of
  the line, so the part that identifies the file was the part that disappeared. The plan now sits
  in a horizontal scroll view, with labels that report their own width instead of expanding to the
  pane.
- **`Installs N file(s)` is hidden while a plan is on screen.** The two lists are not the same
  thing - the plan names the final destination of every file, dependencies and any `--into` move
  included, while the declared list only promises what the artifact contains - but drawing both
  printed the same names twice, and the shorter list was the misleading one. With no plan the
  declared list is still the preview.
- **The four capability sections are tighter.** One multi-line label per section instead of one
  control per value: a vertical layout separates every control, so five items read as five
  paragraphs.
- **`Install Into` is a header on its own line**, with the rules - project-relative, replaces the
  tool's folder, no absolute path or `..` - as its tooltip; the empty state stays inside the field.
  The paragraph that used to sit under it cost every tool the vertical space, including the ones
  nobody was going to move.
- **A `Browse...` button uses the folder panel.** The panel can only return an existing folder, and
  its absolute path is converted to the project-relative form the backend requires; a folder outside
  the project is refused with a reason instead of stored and failing later. A sibling project whose
  path merely starts with this one's is outside, which is what the separator in the prefix check is
  for.
- **Versions moved under a first-level `Versions` submenu** in the row's context menu, leaving the
  top level for the other per-tool actions.
- **The first dependency is selected by default**, instead of the pane opening on "select a
  dependency from the left list".
- **"N versions published" is gone.** It spent a line on every tool with more than one release to
  state a count and name a gesture the menu already carries.

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
