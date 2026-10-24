# ToolRegistry import tool

The companion tool for [ToolRegistry](../ToolRegistry): browse the
registry, verify a payload, install it, and record a receipt so it can be removed
cleanly later.

**Language**: [English](README.en.md) · [中文](README.md)

---

## Documentation

| Document | 中文（主） |
| --- | --- |
| [Architecture](docs/architecture.en.md) (includes the Unity front end) | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| [Decisions](docs/decisions.en.md) | [docs/decisions.zh-CN.md](docs/decisions.zh-CN.md) |
| [Changelog](CHANGELOG.en.md) | [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) |

The normative data contract lives in the registry repository:
[`../ToolRegistry/docs/FRONTEND-INTEGRATION.en.md`](../ToolRegistry/docs/FRONTEND-INTEGRATION.en.md).
This repository only implements it.

---

It is **not** a Unity package with a Unity backend. It is an engine-neutral
Node/npm backend plus, per engine, an adapter and a thin editor front end:

```text
packages/
└─ utool-core/            the backend core: .yaml parsing, registry validation,
                          dependency and capability resolution, artifact
                          verification, install, receipts. NO engine dependency.

providers/
├─ engine-unity/          Unity: the unitypackage container, Unity version and
│                         .NET API level comparison.
└─ engine-godot/          Godot: Godot version comparison. Contributes no container
                          handler, because Godot addons are ordinary archives the
                          core already opens.

apps/
└─ cli/                   utool -- the CLI. Runs with no Unity present.

frontends/
└─ unity-editor/          Editor/ -- the Unity window that drives the CLI.
```

The asymmetry between the two providers is the point of the seam: an engine whose
packages are plain archives adds only engine knowledge, and an engine with a
proprietary package format adds only a container handler. Either way the core is
untouched, and `knownEngines()` in `apps/cli/lib/adapters.js` is the single place
that says which engines a build can serve.

## Why the backend is outside Unity

| Reason | Consequence |
| --- | --- |
| **Compile errors stop Unity, not Node** | If the project does not compile, no editor assembly loads and the window cannot open — but `utool install` still works from a shell. This is the main practical benefit. |
| **Cross-engine** | The backend only knows `.yaml` documents and archives. Another engine needs a new front end, not a new backend. |
| **Testable** | Resolution, verification and receipts are unit-tested with `node --test`, no editor required. |
| **Reusable in CI** | The same CLI validates a registry in a pipeline. |

The cost is a process boundary: the front end talks to the backend through
output records instead of in-memory objects.

## Front ends

| Engine | Where | State |
| --- | --- | --- |
| Unity 2020.3+ | `frontends/unity-editor/Editor` | written and type-checked; **never run in a real editor** on this machine |
| Godot 4.x | `frontends/godot-editor/addons/tool_import` | window plus a Settings window; compiles and loads in 4.7.2 (`npm run check:godot`); click-through still unverified |

Both are reached from a menu and open a window, and both keep their configuration in a Settings
window. Neither contains install logic: the backend decides versions, paths and receipts, and the
front end displays what it decided.

The Godot addon is a normal addons folder - copy `frontends/godot-editor/addons/tool_import` into
a project's `res://addons/`, enable it in **Project → Project Settings → Plugins**, then open
**Project → Tools → Tool Import**. Nothing needs configuring when the checkouts sit side by side:
the registry and the CLI are found by walking up from the project, and the Settings window,
`UTOOL_REGISTRY` / `UTOOL_CLI` / `UTOOL_NODE` override that, in that order.

## Getting started

Requires **Node.js 22.15 or newer** (`.tar.zst` artifacts use the zstd codec that shipped in
`node:zlib` at 22.15) and git.

```pwsh
npm install                                          # the only dependency is `yaml`

node apps/cli/bin/utool.js list --registry ../ToolRegistry
node apps/cli/bin/utool.js show core-editor-utils  --registry ../ToolRegistry
node apps/cli/bin/utool.js plan editor-tool-selection-history --registry ../ToolRegistry
node apps/cli/bin/utool.js validate ../ToolRegistry
npm test
```

Install into a Unity project (writes files and receipts):

```pwsh
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
node apps/cli/bin/utool.js status  --project "C:\path\to\UnityProject"
```

Add `--dry-run` to plan and verify without writing anything.

The destinations a manifest declares are the **default**. `--into` installs the tool you asked
for into a directory of your choosing instead (one tool per call; a dependency keeps its own
layout):

```pwsh
node apps/cli/bin/utool.js install imgui-lib --into "Assets/Plugins/IMGUILib" --project "C:\path\to\UnityProject"
```

`--into` is **project-relative**; absolute paths and `..` are refused. It replaces the directory
the tool already occupies rather than nesting inside it: a tool that lands at `Assets/IMGUILib`
(with `Core/…` below it) and is given `Assets/Vendor` puts `Assets/IMGUILib/Core/x.cs` at
`Assets/Vendor/Core/x.cs`, keeping the internal layout. The default root is derived from the
paths inside the artifact, so the exact value is in the plan (`installRoot` on `PLANTOOL`).

The actual destination is recorded in the receipt, so uninstalling needs no reminder.

## Output modes

| Mode | For | Notes |
| --- | --- | --- |
| default | a human at a terminal | aligned tables and prose |
| `--json` | scripts | one JSON document on stdout |
| `--records` | embedders (the Unity window) | one record per line, TAB separated |

`--records` exists because `UnityEngine.JsonUtility` cannot deserialise a
root-level array, and hand-writing a JSON parser inside the editor would
duplicate logic that belongs to the backend. Record types are documented in
`utool --help`.

Never write prose to stdout in `--records` mode: the Unity front end parses that
stream, so a stray informational line becomes a parse failure. This is not
hypothetical — an informational `host:` line did exactly that during development.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general failure (validation, digest mismatch) |
| 2 | usage error |
| 3 | resolution failure (unknown tool, unsatisfiable constraint, cycle, no capability provider) |
| 4 | platform floor not met (engine or runtime) |

## Testing

```pwsh
npm test                # runs BOTH suites: packages/utool-core/test and apps/cli/test
npm run check:csharp    # type-check the Unity C# with no Unity installed
```

The core suite covers document parsing, semver-lite constraints, registry
validation, dependency and capability resolution (including cycles, optional
dependencies, platform gates, provider selection and unsatisfiable injects),
artifact verification, install with receipts, the rollback version pointer, and
shared-file reference counting. It also validates the real registry in
`../ToolRegistry`, so a format change that breaks the shipped payloads fails
here.

The CLI suite covers argument parsing, including the repeatable-flag bug where
`--also-engine godot` was parsed as `--also-engine g`.

The Unity C# is type-checked against minimal Unity stubs by
`tools/csharp-check.mjs`, so a C# error surfaces in about a second on a machine
with no Unity installed. That harness is a check, not a shipped component.

## Relationship to the registry repository

```text
../ToolRegistry          the data: .yaml documents and sealed artifacts
this directory                 the code: parsing, verification, installation
```

The only interface between them is the data contract in
[`../ToolRegistry/docs/FRONTEND-INTEGRATION.en.md`](../ToolRegistry/docs/FRONTEND-INTEGRATION.en.md)
plus `schema/tool.schema.json`. Either side can be replaced as long as that holds.

## Not yet implemented

- **Uninstall execution.** The exact plan and the shared-file reference counting are
  implemented and tested; deleting files is deliberately the last thing to switch on.
- **External source resolution.** The backend reports an `external` target as
  caller-resolved rather than shelling out to git.
- **Executing a rollback.** `utool rollback` reports the recorded target digest, but a
  superseded artifact is not guaranteed to still be published - a maintainer may delete
  it once nothing pins it. Naming what must be re-published is the honest behaviour.
