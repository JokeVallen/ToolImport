# DevCatToolRegistry import tool

The companion tool for [DevCatToolRegistry](../DevCatToolRegistry): browse the
registry, verify a payload, install it, and record a receipt so it can be removed
cleanly later.

**Language**: [English](README.en.md) · [中文](README.zh-CN.md)

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

## Getting started

```pwsh
npm install                                          # the only dependency is `yaml`

node apps/cli/bin/utool.js list --registry ../DevCatToolRegistry
node apps/cli/bin/utool.js show core-editor-utils  --registry ../DevCatToolRegistry
node apps/cli/bin/utool.js plan editor-tool-selection-history --registry ../DevCatToolRegistry
node apps/cli/bin/utool.js validate ../DevCatToolRegistry
npm test
```

Install into a Unity project (writes files and receipts):

```pwsh
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
node apps/cli/bin/utool.js status  --project "C:\path\to\UnityProject"
```

Add `--dry-run` to plan and verify without writing anything.

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
`../DevCatToolRegistry`, so a format change that breaks the shipped payloads fails
here.

The CLI suite covers argument parsing, including the repeatable-flag bug where
`--also-engine godot` was parsed as `--also-engine g`.

The Unity C# is type-checked against minimal Unity stubs by
`tools/csharp-check.mjs`, so a C# error surfaces in about a second on a machine
with no Unity installed. That harness is a check, not a shipped component.

## Relationship to the registry repository

```text
../DevCatToolRegistry          the data: .yaml documents and sealed artifacts
this directory                 the code: parsing, verification, installation
```

The only interface between them is the data contract in
[`../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md`](../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md)
plus `schema/tool.schema.json`. Either side can be replaced as long as that holds.

## Not yet implemented

- **Uninstall execution.** The exact plan and the shared-file reference counting are
  implemented and tested; deleting files is deliberately the last thing to switch on.
- **External source resolution.** The backend reports an `external` target as
  caller-resolved rather than shelling out to git.
- **Executing a rollback.** `utool rollback` reports the recorded target digest, but
  the registry publishes one version per tool, so the bytes a tool replaced are
  normally no longer published. Naming what must be re-published is the honest
  behaviour.
