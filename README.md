# UnityDevCommonLib Frontend Tools — development workspace

This directory is the **development home of the companion editor tool** for
[UnityDevCommonLib](../UnityDevCommonLib).

It is deliberately kept outside the registry repository:

| | UnityDevCommonLib | this directory |
| --- | --- | --- |
| Purpose | payload format + registry contents | the editor UI that imports payloads |
| Contents | `tool.json` manifests, sealed artifacts | C# Editor sources, UI, tests |
| Version control | GitHub: `JokeVallen/UnityDevCommonLib` | local git only (not yet pushed) |
| Changes when | a tool is published | the frontend iterates |

The two sides talk **only** through the data contract in
[`../UnityDevCommonLib/docs/FRONTEND-INTEGRATION.md`](../UnityDevCommonLib/docs/FRONTEND-INTEGRATION.md)
plus the JSON Schema at `../UnityDevCommonLib/schema/tool.schema.json`. Either side can be replaced as
long as that contract holds.

---

## Status

Skeleton. The registry format is frozen at `schemaVersion 1` and three example payloads exist, so the
frontend can be built against real data today:

```text
../UnityDevCommonLib/index.json                                  flat catalog to list
../UnityDevCommonLib/payloads/core-editor-utils/tool.json         no dependencies
../UnityDevCommonLib/payloads/editor-tool-selection-history/tool.json   has a dependency
../UnityDevCommonLib/payloads/libs-gltf-importer/tool.json        external, metadata only
```

---

## Intended layout

```text
UnityDevCommonLib_FrontToolsDev/
├─ README.md
├─ .gitignore
├─ docs/
│  ├─ architecture.md      component boundaries and the install pipeline
│  └─ decisions.md         why the frontend is shaped the way it is
├─ src/                    Editor C# sources (created when development starts)
│  ├─ Registry/            fetch + parse index.json / tool.json
│  ├─ Resolution/          dependency graph, version constraints, platform gate
│  ├─ Install/             artifact verification, extraction, receipts, rollback
│  └─ UI/                  the selection window
└─ tests/                  unit tests for resolution and verification
```

Suggested assembly: `DevCat.UnityDevCommonLib.FrontTools.Editor` (Editor-only asmdef).

---

## Design constraints carried over from the registry

These are the rules the frontend must not soften; they are restated in full in the contract document.

1. **Never import loose files** — only `unitypackage` / `zip` payloads.
2. **Verify before writing** — `sha256` and `size` must match, or the whole plan aborts.
3. **Reject unsafe archive entries** — absolute paths and `..` segments.
4. **Enforce the floors** — `minUnityVersion` / `minDotNetVersion` block the install, they do not warn.
5. **Resolve required dependencies transitively** — never auto-break a cycle.
6. **Show the plan before executing** — files, sizes, and why each tool is included.
7. **Write a receipt per install** — under `Library/`, so uninstall is exact and nothing local leaks
   into version control.
8. **Reject unknown `schemaVersion` values** rather than guessing at their shape.

---

## Reproducing the registry locally

The frontend can be developed without network access by pointing it at the sibling checkout:

```pwsh
python ..\UnityDevCommonLib\tools\validate_registry.py ..\UnityDevCommonLib
```

A local path acts as the registry root, with the same file layout the HTTP path exposes.
