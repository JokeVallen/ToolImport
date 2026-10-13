# DevCatToolRegistry import tool

The companion tool for [DevCatToolRegistry](../DevCatToolRegistry): browse the
registry, verify a payload, install it, and record a receipt so it can be removed
cleanly later.

It is **not** a Unity package with a Unity backend. It is an engine-neutral
Node/npm backend plus, per engine, an adapter and a thin editor front end:

```text
packages/
└─ utool-core/            the backend core: .utool parsing, registry validation,
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
| **Cross-engine** | The backend only knows `.utool` documents and archives. Another engine needs a new front end, not a new backend. |
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
stream, so a stray informational line becomes a parse failure.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general failure (validation, digest mismatch) |
| 2 | usage error |
| 3 | resolution failure (unknown tool, unsatisfiable constraint, cycle) |
| 4 | platform floor not met (Unity or .NET) |

## Testing

```pwsh
npm test        # node --test packages/utool-core/test/
```

The suite covers document parsing, semver-lite constraints, registry validation,
dependency resolution (including cycles, optional dependencies and platform
gates), artifact verification, install with receipts, shared-file reference
counting — and it validates the real registry in `../DevCatToolRegistry`, so a
format change that breaks the shipped payloads fails here.

The Unity C# is type-checked against minimal Unity stubs so it can be verified on
a machine without Unity installed. That harness lives outside the repository and
is not shipped.

## Relationship to the registry repository

```text
../DevCatToolRegistry          the data: .utool documents and sealed artifacts
this directory                the code: parsing, verification, installation
```

The only interface between them is the data contract in
[`../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md`](../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.zh-CN.md)
(English: [`…en.md`](../DevCatToolRegistry/docs/FRONTEND-INTEGRATION.en.md)) plus
`schema/tool.schema.json`. Either side can be replaced as long as that holds.

Not yet enabled: uninstall execution (the exact plan and reference counting are
implemented and tested; deleting files is deliberately the last thing to switch
on) and resolution of external git sources (the backend reports them as
caller-resolved rather than shelling out to git).
