# Import tool architecture

Status: **implemented**. This document describes the shape the code actually has,
not a plan.

**Language**: [English](architecture.en.md) · [中文](architecture.zh-CN.md) · [back to index](../README.md)

---

## Layers

```text
packages/utool-core        engine-neutral: format, containers, resolution,
                           verification, install, receipts
providers/engine-<name>    engine adapters: container formats + requirement comparison
apps/cli                   the CLI: argument parsing, adapter loading, three output modes
frontends/<engine>-editor  one visual front end per engine (currently Unity only)
```

The core has **no** `if (engine === 'unity')` branch. Two facts you can check in the
code:

- in `packages/utool-core/src/`, `unitypackage` appears only in **comments** (five of
  them, all explaining that the core deliberately does not know the word). It appears
  **zero** times in executable code;
- verifying a real unitypackage with a core-only container registry fails with
  `E-ARTIFACT-FORMAT-UNSUPPORTED`. That is asserted by a test rather than claimed in
  prose.

---

## Pipeline

```text
    RegistrySource        read index.yaml, fetch tool.yaml by manifestPath
          |
          v
    parseUtool + checkHeader    YAML -> mapping; verify kind and formatVersion
          |
          v
    ToolManifest          engine-neutral view + target(engine) for one engine
          |
          v
    resolveSelection      required closure, constraints, cycles, capability
                          conflicts, optional provider selection for injects
          |
          v
    planInstallation      fetch and verify every (tool, engine) artifact - writes nothing
          |
          v
    [ front-end review ]  the user sees files, sizes, and why each tool is included
          |
          v
    executeInstall        write, unpacking through the container handlers
          |
          v
    ReceiptStore          one receipt per tool, with the version pointer and files
```

`planInstallation` and `executeInstall` are **deliberately separate phases**. The plan
phase verifies every artifact; if any one fails it throws and **not a single byte is
written**. A half-install caused by a bad download is therefore structurally
impossible rather than merely unlikely.

Every stage is pure except the fetching in `planInstallation` and the writing in
`executeInstall`. Resolution and planning are testable with **no editor and no
network**.

---

## `packages/utool-core` — the core

| Module | Responsibility |
| --- | --- |
| `loader.js` | one YAML document, mapping root, explicit `kind` / `formatVersion` checks, and a **UTF-8 BOM rejected by name** because it silently renames the first key so every lookup misses |
| `schema.js` | a draft-07 JSON Schema subset mirroring the Python validator, so the CI gate and the backend agree on what "valid" means |
| `manifest.js` | `ToolManifest` and `ToolTarget`; engine-neutral accessors at the top, engine-specific behind `target(engine)` |
| `format.js` | closed vocabulary: `kind`, `formatVersion`, artifact types, core archive formats, capability and artifact-name parsing |
| `containers.js` | `ContainerRegistry` and the core handlers (`zip`, `tgz`, `tar.gz`, `tar.zst`, single file) |
| `artifacts.js` | size, `sha256`, container magic, and the escape checks on **entry names and destinations** |
| `resolver.js` | dependency closure, constraints, cycles, capability conflicts and provider selection |
| `install.js` | the plan and execute phases; the only write context lives here |
| `receipts.js` | receipt read/write, shared-file reference counting, the version pointer and rollback planning |
| `registry.js` | registry validation, the same rules the Python validator enforces |
| `source.js` | local directory and HTTP sources |

### The container handler contract

An adapter implements two hooks, and both go through the same item-reading code, so
**the verified file list and the written file list cannot drift apart**:

```js
{
  id: 'unity:unitypackage',
  formats: ['unitypackage'],
  inspect(bytes, artifact, ctx) { /* report destinations, write nothing */ },
  async extract(bytes, artifact, ctx) { /* write via ctx, return project-relative paths */ },
}
```

Path resolution belongs to the core's **write context**, not to the handler:
`ctx.resolve()` applies `contentRoot` and refuses anything outside the project root,
and `ctx.relative()` yields the project-relative path a receipt must record.

> That rule was forced by a real defect: the archive handler reported paths as they
> appear **inside** the archive rather than where they land. Without a `contentRoot`
> the two are identical, so nothing noticed. With one (Godot's `addons/core_utils`)
> the receipt named `plugin.cfg` while the file was at `addons/core_utils/plugin.cfg`,
> so **uninstall would have searched the wrong place and left residue**. A test now
> asserts that every path in a receipt exists on disk.

---

## `providers/` — engine adapters

An adapter contributes two things to the core, and may contribute only one of them:

| Adapter | Container handlers | Requirement comparison | Note |
| --- | --- | --- | --- |
| `engine-unity` | `unitypackage` | `minEngineVersion`, `minRuntimeVersion` | Unity packages are proprietary, so a handler is needed |
| `engine-godot` | **none** | `minEngineVersion` | Godot addons are ordinary archives the core already opens |

`meetsRequirement(engine, key, value, host)` is three-valued, and **the distinction is
deliberate**:

| Return | Meaning |
| --- | --- |
| `true` | the host meets the floor |
| `false` | the host does not |
| `undefined` | **this adapter cannot judge that key**, so the core **reports** the floor without enforcing it |

Returning `false` for an unfamiliar key would silently block installs the moment
someone adds a requirement key, which is exactly the coupling the adapter split exists
to prevent.

---

## `apps/cli` — the CLI

| Module | Responsibility |
| --- | --- |
| `bin/utool.js` | command dispatch and presentation |
| `lib/adapters.js` | the **single** place that says which engines exist; dynamic import, so a caller that only handles general archives depends on no engine package |
| `lib/args.js` | argument parsing, including repeatable value flags and camelCase key mapping |
| `lib/records.js` | line-record output for embedders |
| `lib/output.js` | tables, JSON, warnings |
| `lib/host.js` | read the editor version from `ProjectSettings/ProjectVersion.txt` |
| `lib/write-index.js` | regenerate `index.yaml` |

Commands: `list`, `show`, `plan`, `verify`, `install`, `uninstall`, `rollback`,
`status`, `validate`.

**The primary engine's adapter is required**: when a user asks to install into an
engine this build cannot serve, substituting another engine's bytes would be wrong.
**An extra engine (`--also-engine`) is best-effort**, reported as a warning and
skipped, so the requested install still completes.

---

## `frontends/unity-editor` — the Unity front end

The C# side contains **no format logic**: it does not parse `.yaml`, does not resolve
dependencies, does not hash anything. It runs the CLI and renders the result.

| Type | Responsibility |
| --- | --- |
| `CliRunner` | locate and run the CLI; `UTOOL_CLI`, or walk up from the project to `UnityToolImport/apps/cli/bin/utool.js`; uses `ArgumentList` so paths with spaces are safe |
| `BackendRecords` | parse the record stream; field order must match `records.js` |
| `ImportToolWindow` | toolbar (registry, engine selector), tool list, per-target detail panes, plan confirmation, install |

**Why records rather than JSON**: `UnityEngine.JsonUtility` cannot deserialise a
root-level array, and hand-writing a JSON parser inside the editor would duplicate
logic that belongs to the backend. Splitting a record stream on TAB is small enough to
be obviously correct, and an unknown record type can be ignored, so the backend can add
record types without breaking an older window.

The detail pane **deliberately does not hard-code requirement key names**; it prints
whatever the backend reports. Which keys exist is the adapter's business, so adding one
requires no change here.

### File layout

```text
frontends/unity-editor/Editor/
├─ CliRunner.cs         locate and run the backend CLI, capture its output
├─ BackendRecords.cs    parse the line-oriented --records stream
├─ ImportToolWindow.cs  the window: list, details, verify, install
└─ DevCat.ToolImport.Editor.asmdef
```

### Installing it into a project

**Why it is worth keeping thin**: if the project has **compile errors**, Unity loads no
editor assembly, so nothing under `Editor/` runs — the window cannot open and cannot
help. The backend can:

```pwsh
node apps/cli/bin/utool.js validate ../DevCatToolRegistry
node apps/cli/bin/utool.js plan core-editor-utils --registry ../DevCatToolRegistry
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
```

**That is the whole reason for the split**: the window is a convenience layer over a
tool that works without Unity.

The window resolves the backend and the registry in this order:

| What | Looked up as |
| --- | --- |
| CLI script | `UTOOL_CLI` env var, else a `UnityToolImport` checkout found by walking up from the project |
| Node | `UTOOL_NODE` env var, else `node` on `PATH` |
| Registry | `UTOOL_REGISTRY` env var, else a sibling `DevCatToolRegistry` checkout, else the published GitHub raw URL |

Once the front end is a UPM package, drop `Editor/` into the project (or add the package
by Git URL) and run `npm install` inside the backend checkout so the `yaml` dependency
is present.

### Not yet implemented here

- **Uninstall.** The backend computes an exact uninstall plan
  (`utool uninstall --dry-run`) with shared-file reference counting, but execution is
  deliberately still disabled: removing files is the last thing to enable.
- **External git resolution.** The backend reports such tools as caller-resolved; the
  front end shows the upstream URL and ref instead of pretending to install them.

---

## Boundaries already settled

| Decision | Rationale |
| --- | --- |
| The registry is read-only data; only the front end writes | Keeps "no pollution" enforceable in one place |
| Verify the entire plan before writing anything | Avoids half-installed states that are hard to describe to a user |
| Receipts under `Library/` | Unity never commits `Library/`, so local state cannot leak into a consumer's VCS |
| Errors as values, not exceptions | A UI must show every resolution problem, not the first |
| The core knows no engine; adapters register formats | This is why cross-engine works structurally rather than by promise |
| A receipt records where a file **is** | Otherwise uninstall searches the wrong place and leaves residue |

The normative data contract is
[`../../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md`](../../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md);
the reasoning for the directory layout is in [`decisions.en.md`](decisions.en.md).
