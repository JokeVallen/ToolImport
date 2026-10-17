# Decision record

Short notes on choices that are expensive to reverse. Each entry states the decision,
the reasoning, and what would make us revisit it.

**Language**: [English](decisions.en.md) · [中文](decisions.zh-CN.md) · [back to index](../README.md)

---

## D-1 — The import tool lives outside the registry repository

**Decision.** The editor front end is developed in `ToolImport/`, a sibling
directory with its own local git history, not inside `ToolRegistry`.

**Why.**

- The registry's history should read as a record of *what was published*, not as an
  application's commit log. Mixed histories make both harder to audit.
- A consumer who adds the registry by UPM/Git URL must not download the front end's
  sources, and a developer of the front end must not be forced to download the whole
  payload registry.
- The two have different release rhythms: publishing a tool is rare and deliberate; the
  front end iterates constantly.
- The boundary is a data contract (`index.yaml`, `tool.yaml`, JSON Schema), so the
  split costs almost nothing in coupling — either side can be rewritten against the
  same contract.

**Revisit if.** The contract churns so often that version skew between the two
repositories becomes the dominant source of bugs; at that point a single repository
with two UPM packages would be simpler.

**Status.** Not yet pushed to a remote, by choice. If published, the recommended shape
is a UPM package (`com.devcat.toolimport`). The `com.devcat.` segment stays even though the
repositories dropped the prefix: a UPM id's leading segment is namespace *ownership*, not a
name on a tool, and shortening it to `com.toolimport` would claim a domain nobody owns.

---

## D-2 — The importer is an editor tool, not a UPM package manager

**Decision.** Tools are imported by the front end, not by declaring UPM dependencies.

**Why.**

- UPM resolves *packages*, not *editor tools*: a single script, a menu item, or an asset
  pack is not a natural package, and forcing one package per tool is heavy.
- UPM cannot express "install these three chosen tools and write receipts"; it installs
  whatever the dependency graph demands.
- The registry must support non-UPM payloads (`.unitypackage`, `.zip`, `.tgz`, asset
  packs, a bare `dll`).
- Receipts and reference-counted uninstall are requirements UPM does not provide.

**Still supported.** The registry repository is itself a valid UPM package, and
`artifact.type: external` entries may point at real UPM packages, so UPM remains usable
where it fits.

---

## D-3 — Payloads are sealed archives, never loose files

**Decision.** Only a container or a single-file artifact may be imported (types
`archive`, `package`, `file`). Loose `.cs` files are rejected by
`tools/validate_registry.py`.

**Why.** A loose-file import cannot be hash-verified, leaves untracked assets in the
consumer's project, and makes exact uninstall impossible. An archive is atomic,
verifiable and removable.

**Cost.** Updating a tool means re-exporting an artifact rather than editing a file in
place, and the registry stores binaries that Git cannot diff meaningfully.

**Revisit if.** Unity gains a first-class, receipt-friendly way to import individual
source files from a remote registry.

---

## D-4 — One manifest describes exactly one version

**Decision.** `tool.yaml` describes a single published version. Multi-version manifests
(`versions[]`) are reserved for a future `formatVersion` and are rejected today.

**Why.** Simplicity is worth more than version history at this size: resolution lands on
the one version the registry provides, so there is nothing to select between. Full
historical manifests would add a resolution dimension with no consumer.

**Revisit if.** A tool needs to support a version for Unity 2019 and another for Unity
2021 simultaneously, i.e. when one artifact cannot serve every supported host.

---

## D-5 — Artifacts are immutable; a change means a new version

**Decision.** Once an artifact is committed, its bytes never change.

**Why.** Receipts, caches and `sha256` verification are all keyed on content. Rewriting
published bytes silently invalidates every receipt that referenced them, which destroys
the exactness of uninstall. **It is also what makes the version pointer meaningful**: a
rollback target is a digest, and that digest has to be trustworthy.

**Enforcement.** `tools/validate_registry.py` recomputes `sha256` on every run, so an
edited artifact fails CI unless the manifest is updated — which is the signal to bump
the version instead.

---

## D-6 — The core knows no engine; adapters register formats

**Decision.** `packages/utool-core` contains no engine-name branch. An engine
contributes formats through a container registry, and requirement comparison through a
three-valued `meetsRequirement`.

**Why.** A registry that hard-codes one engine **suppresses the tools most worth
having** — the cross-engine ones. A C# library usable in both Unity and Godot must be
able to say so once, rather than being duplicated or forced to pick a side.

**Cost.** An adapter must return `undefined` for a key it does not understand, never
`false`; returning `false` would silently block installs the moment a new requirement
key appears, recreating the very coupling this split avoids.

**Evidence.** Verifying a real unitypackage with a core-only container registry fails
with `E-ARTIFACT-FORMAT-UNSUPPORTED`, and `unitypackage` appears in
`packages/utool-core/src/` only inside comments. Both are checkable in the code and
asserted by tests.

---

## D-7 — A receipt records where a file **is**

**Decision.** A container handler reports **project-relative** destinations, not
paths as they appear inside the archive. Path resolution belongs to the core's write
context; a handler must not decide it.

**Why.** Forced by a real defect: the archive handler reported archive-relative paths,
so a Godot payload with a `contentRoot` had its files recorded as `plugin.cfg` while
they lived at `addons/core_utils/plugin.cfg`. **Uninstall would have searched the wrong
place and left residue**, and every unit test was green because they tested the archive
reader rather than the receipt.

**Enforcement.** An install test asserts, against **real** registry artifacts, that
every path in a receipt exists on disk.
