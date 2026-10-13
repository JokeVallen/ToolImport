# Decision record

Short notes on choices that are expensive to reverse. Each entry states the decision, the reasoning,
and what would make us revisit it.

---

## D-1 — The frontend lives outside the registry repository

**Decision.** The editor frontend is developed in `UnityToolImport/`, a sibling
directory with its own local git history, not inside `DevCatToolRegistry`.

**Why.**

- The registry's history should read as a record of *what was published*, not as an application's
  commit log. Mixed histories make both harder to audit.
- A consumer who adds the registry by UPM/Git URL must not download the frontend's sources, and a
  consumer of the frontend must not download the whole payload registry.
- The two have different release rhythms: publishing a tool is rare and deliberate; the frontend
  iterates constantly.
- The boundary is a data contract (`index.json`, `tool.json`, JSON Schema), so the split costs nothing
  in coupling — either side can be rewritten against the same contract.

**Revisit if.** The contract churns so often that version skew between the two repositories becomes the
dominant source of bugs; at that point a single repository with two UPM packages would be simpler.

**Status.** Not yet pushed to a remote, by choice. If published, the recommended shape is a UPM package
(`com.devcat.unitydevcommonlib.fronttools`).

---

## D-2 — The importer is an editor tool, not a UPM package manager

**Decision.** Tools are imported by the frontend, not by declaring UPM dependencies.

**Why.**

- UPM resolves *packages*, not *editor tools*: a single script, a menu item, or an asset pack is not a
  natural package, and forcing one package per tool is heavy.
- UPM cannot express "install these three chosen tools and write receipts"; it installs whatever the
  dependency graph demands.
- The registry must support non-UPM payloads (`.unitypackage`, `.zip`, asset packs, shader packs).
- Receipts and reference-counted uninstall are requirements UPM does not provide.

**Still supported.** The whole repository is a valid UPM package, and `source.kind = "external"` entries
may point at real UPM packages, so UPM remains usable where it fits.

---

## D-3 — Payloads are sealed archives, never loose files

**Decision.** Only `.unitypackage` and `.zip` may be imported. Loose `.cs` files are rejected by
`tools/validate_registry.py`.

**Why.** A loose-file import cannot be hash-verified, leaves untracked assets in the consumer's project,
and makes exact uninstall impossible. An archive is atomic, verifiable and removable.

**Cost.** Updating a tool means re-exporting an artifact rather than editing a file in place, and the
registry stores binaries that Git cannot diff meaningfully.

**Revisit if.** Unity gains a first-class, receipt-friendly way to import individual source files from a
remote registry.

---

## D-4 — One manifest describes exactly one version

**Decision.** `tool.json` describes a single published version. Multi-version manifests are reserved for
a future `schemaVersion` and are rejected today.

**Why.** Simplicity is worth more than version history at this size: the frontend resolves to a single
registry-provided version, so there is nothing to select between. Full historical manifests would add a
resolution dimension with no consumer.

**Revisit if.** A tool needs to support a version for Unity 2019 and another for Unity 2021
simultaneously, i.e. when one artifact cannot serve every supported host.

---

## D-5 — Artifacts are immutable; a change means a new version

**Decision.** Once an artifact is committed, its bytes never change.

**Why.** Receipts, caches and `sha256` verification are all keyed on content. Rewriting published bytes
silently invalidates every receipt that referenced them, which destroys the exactness of uninstall.

**Enforcement.** `tools/validate_registry.py` recomputes `sha256` on every run, so an edited artifact
fails CI unless the manifest is updated — which is the signal to bump the version instead.
