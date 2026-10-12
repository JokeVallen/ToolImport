# Unity editor front end

A thin Unity layer that drives the Node backend. It contains **no format logic**:
no `.utool` parsing, no dependency resolution, no hashing. It shells out to
`utool` and renders what comes back.

```text
Editor/
├─ CliRunner.cs          locates and runs the backend CLI, captures its output
├─ BackendRecords.cs     parses the line-oriented --records stream
├─ ImportToolWindow.cs   the window: list, details, verify, install
└─ DevCat.UnityDevCommonLib.ImportTool.Editor.asmdef
```

## Why so thin

If this project has **compile errors**, Unity loads no editor assembly, so nothing
under `Editor/` runs — the window cannot open and cannot help. The backend can:

```pwsh
node apps/cli/bin/utool.js validate ../UnityDevCommonLib
node apps/cli/bin/utool.js plan core-editor-utils --registry ../UnityDevCommonLib
node apps/cli/bin/utool.js install core-editor-utils --project "C:\path\to\UnityProject"
```

That is the whole reason for the split. The window is a convenience over a tool
that works without Unity.

## Why records instead of JSON

`UnityEngine.JsonUtility` cannot deserialise a root-level array, and embedding a
JSON parser in the editor would duplicate logic that belongs to the backend. The
backend therefore offers `--records`: one record per line, TAB separated, with
escaped field values. Parsing becomes a split, and an unknown record type is
ignored rather than fatal — so the backend can add record types without breaking
an older window.

## Installing this into a project

The window resolves the backend and registry in this order:

| What | Looked up as |
| --- | --- |
| CLI script | `UTOOL_CLI` env var, else a `UnityDevCommonLib_FrontToolsDev` checkout found by walking up from the project |
| Node | `UTOOL_NODE` env var, else `node` on `PATH` |
| Registry | `UTOOL_REGISTRY` env var, else a sibling `UnityDevCommonLib` checkout, else the published GitHub raw URL |

Once this is a UPM package, drop `Editor/` into the project (or add the package
by Git URL) and run `npm install` inside the backend checkout so the `yaml`
dependency is present.

## Not yet implemented here

- Uninstall. The backend computes an exact uninstall plan
  (`utool uninstall --dry-run`) with shared-file reference counting, but execution
  is deliberately still disabled: removing files is the last thing to enable.
- External git resolution. The backend reports such tools as caller-resolved; the
  front end shows the upstream URL and ref instead of pretending to install them.
