using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace DevCat.ToolImport.Editor
{
    /// <summary>
    /// The editor front end: browse the registry, review a plan, install.
    /// </summary>
    /// <remarks>
    /// This window deliberately contains no format logic. It shells out to the
    /// Node backend (<see cref="CliRunner"/>) and renders what comes back. That
    /// separation is what makes the tool survivable: if this project has compile
    /// errors, Unity loads no editor assembly and this window cannot run at all,
    /// but the backend CLI still works from a shell and can install or repair
    /// from there.
    ///
    /// It also means the same backend can drive another engine later.
    /// </remarks>
    internal sealed class ImportToolWindow : EditorWindow
    {
        private const string RegistryPathVariable = "UTOOL_REGISTRY";
        private const string DefaultRemoteRegistry =
            "https://raw.githubusercontent.com/JokeVallen/DevCatToolRegistry/main";

        /// <summary>
        /// The registry listing, shared across window instances for this editor session.
        /// </summary>
        /// <remarks>
        /// Unity destroys an EditorWindow when it is closed, so per-instance state is
        /// lost and every reopen demanded Refresh, then re-select, then Verify again.
        /// The listing is a property of the REGISTRY, not of the window, so caching it
        /// per session is both correct and what a user expects.
        ///
        /// It is a list of what is available, not a plan: nothing is written and no
        /// artifact is fetched until Install. An explicit Refresh still re-reads the
        /// registry, so a stale cache is one click from correct rather than a trap.
        /// A domain reload (script recompile, entering play mode) clears it, which is
        /// also when the registry is most likely to have changed.
        /// </remarks>
        private static List<AvailableTool> cachedTools;
        private static string cachedRegistryLocator = string.Empty;

        /// <summary>
        /// Tool ids this project has a receipt for, shared across window instances.
        /// </summary>
        /// <remarks>
        /// Used to disable Uninstall for a tool that is not installed. Asking the
        /// backend with `status` keeps this derived from the receipts rather than
        /// guessed from the project layout.
        /// </remarks>
        private static readonly HashSet<string> installedIds = new HashSet<string>();

        private List<AvailableTool> tools
        {
            get { return cachedTools ?? (cachedTools = new List<AvailableTool>()); }
        }

        private Vector2 listScroll;
        private Vector2 detailScroll;
        private string selectedId = string.Empty;
        private string registryLocator = string.Empty;
        private string statusMessage = "Press Refresh to list the registry.";
        private BackendRecords detailRecords;
        private BackendRecords planRecords;

        /// <summary>
        /// Records from the last FAILED command, shown as an error panel.
        /// </summary>
        /// <remarks>
        /// Separate from planRecords so a failure is never mistaken for a plan, and so it
        /// survives until the next successful call. A user who replaces a payload by hand
        /// must be able to see that the digest no longer matches, and what the two values
        /// are -- the bottom status line is far too small for that.
        /// </remarks>
        private BackendRecords failureRecords;
        private bool busy;

        /// <summary>Free-text filter over the tool list.</summary>
        private string searchText = string.Empty;

        /// <summary>Which subset of the registry the list shows.</summary>
        private ToolFilter filter = ToolFilter.All;

        /// <summary>
        /// Named subsets, chosen instead of a set of independent toggles.
        /// </summary>
        /// <remarks>
        /// Independent toggles ("installed" and "not installed" both on) have states that
        /// mean nothing, and the user has to work out which combination they are in. One
        /// choice from a list cannot be contradictory.
        /// </remarks>
        private enum ToolFilter
        {
            All,
            Installed,
            NotInstalled,
            ThisEngine,
        }

        /// <summary>Search box contents are reset when the user clears it.</summary>
        private const string SearchControlName = "DevCatToolSearch";

        /// <summary>Cached filtered list, rebuilt only when its inputs change.</summary>
        private List<AvailableTool> filteredTools;
        private string filterKey;
        private ToolFilter filterInstalledOnly;
        private int filterSourceCount = -1;

        /// <summary>
        /// One command waiting for the in-flight one to finish.
        /// </summary>
        /// <remarks>
        /// Single-slot on purpose. A queue would let a burst of clicks pile up commands
        /// that are stale by the time they run; keeping only the newest is both simpler
        /// and closer to what the user meant.
        /// </remarks>
        private Action queuedCommand;

        /// <summary>Engine to install into; chosen in the toolbar.</summary>
        private string EngineName = "unity";

        [MenuItem("Window/DevCatToolRegistry/工具库导入工具 (Import Tool)", priority = 1200)]
        private static void Open()
        {
            var window = GetWindow<ImportToolWindow>();
            window.titleContent = new GUIContent("Import Tool");
            window.minSize = new Vector2(620f, 380f);
            window.Show();
        }

        private void OnEnable()
        {
            registryLocator = ResolveRegistryLocator();

            // Show the cached listing immediately, and load it when there is nothing
            // cached yet. On a reopen this is instant and silent; on a first open it
            // fills itself instead of showing an empty pane that says "press Refresh".
            //
            // The installed scan and the listing CANNOT be started as two independent
            // calls: Run holds ONE busy flag, so the second call returns immediately and
            // silently, and the window sat on "Loading the registry..." until the user
            // pressed Refresh. Sequencing them is the fix -- the scan is local and fast,
            // so doing it first costs nothing.
            if (cachedTools != null && cachedTools.Count > 0)
            {
                statusMessage = string.Format("Registry: {0} - {1} tool(s).", registryLocator, cachedTools.Count);
                RefreshInstalled();
            }
            else
            {
                statusMessage = "Loading the registry...";
                RefreshInstalled(Refresh);
            }
        }

        /// <summary>
        /// Re-read which tools this project has installed.
        /// </summary>
        /// <param name="then">
        /// Queued to run after this call finishes. It CANNOT be invoked directly from the
        /// callback: the callback runs while Run still holds `busy`, so a direct call would
        /// be dropped -- which is exactly the bug that left the window on "Loading the
        /// registry...".
        /// </param>
        private void RefreshInstalled(Action then = null)
        {
            Run("status", records =>
            {
                installedIds.Clear();
                foreach (string[] fields in records.Of("RECEIPT"))
                {
                    if (fields.Length > 0) installedIds.Add(fields[0]);
                }
                // The installed set feeds the filter, so a changed set invalidates it.
                // Without this an install would not appear under "Installed" until the
                // search text changed.
                filteredTools = null;
                QueueCommand(then);
            });
        }

        private void OnGUI()
        {
            // Recompute the visible set ONCE per frame. It used to be rebuilt by the
            // toolbar (for the count) and again by the list, so every repaint did the
            // whole filter twice and allocated two lists -- and IMGUI repaints on every
            // mouse move. OnGUI is also called several times per frame for layout and
            // repaint events, so this is multiplied again.
            RebuildVisibleTools();

            DrawToolbar();

            if (tools.Count == 0)
            {
                EditorGUILayout.HelpBox(statusMessage, MessageType.Info);
                return;
            }

            EditorGUILayout.BeginHorizontal();
            DrawToolList();
            DrawDetails();
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.LabelField(statusMessage, EditorStyles.miniLabel);
        }

        /// <summary>
        /// Recompute the filtered list, but only when its inputs changed.
        /// </summary>
        /// <remarks>
        /// The inputs are the search text, the installed flag and the tool list itself,
        /// so typing is the only thing that triggers a rebuild. This is also why there is
        /// no debounce: filtering is a substring scan over a handful of small strings
        /// held in memory, which costs microseconds. Debouncing would add a timer, a
        /// repaint dependency and a frame of lag to hide a cost that is not there. If a
        /// registry ever held thousands of tools this becomes worth revisiting -- the
        /// trigger would be a measured cost, not the fact that the user is typing.
        /// </remarks>
        private void RebuildVisibleTools()
        {
            if (filteredTools != null
                && filterKey == searchText
                && filterInstalledOnly == filter
                && filterSourceCount == tools.Count)
            {
                return;
            }

            filterKey = searchText;
            filterInstalledOnly = filter;
            filterSourceCount = tools.Count;

            var visible = new List<AvailableTool>();
            foreach (AvailableTool tool in tools)
            {
                if (filter == ToolFilter.Installed && !installedIds.Contains(tool.Id)) continue;
                if (filter == ToolFilter.NotInstalled && installedIds.Contains(tool.Id)) continue;
                // "Usable here" means this engine has a target. It deliberately says
                // nothing about whether the artifact can be INSTALLED -- that needs the
                // TARGET record's artifact type, which only `show` returns, and fetching
                // it for every row would cost one backend call per tool.
                if (filter == ToolFilter.ThisEngine && !tool.Supports(EngineName)) continue;
                if (!Matches(tool, searchText)) continue;
                visible.Add(tool);
            }
            filteredTools = visible;
        }

        /// <summary>Tools passing the current search text and filter.</summary>
        private List<AvailableTool> VisibleTools()
        {
            if (filteredTools == null) RebuildVisibleTools();
            return filteredTools;
        }

        /// <summary>
        /// Does a tool match the search text?
        /// </summary>
        /// <remarks>
        /// Matches the DISPLAY NAME only, case-insensitively, on a substring.
        ///
        /// This used to search id, type, tags and provides as well, which produced results
        /// that looked wrong: typing `s` returned "gITF Importer" because its id is
        /// `libs-gltf-importer`. The match was real but invisible -- the id is not on
        /// screen -- so the list appeared to ignore the query. A search that matches
        /// something the user cannot see is indistinguishable from a bug, and the visible
        /// name is what people search by.
        ///
        /// Filtering tags and capabilities has its own control, which is honest about what
        /// it is filtering on. See ToolFilter.
        /// </remarks>
        internal static bool Matches(AvailableTool tool, string needle)
        {
            if (string.IsNullOrEmpty(needle)) return true;
            string name = tool.DisplayName;
            if (string.IsNullOrEmpty(name)) return false;
            return name.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // ------------------------------------------------------------------
        // toolbar
        // ------------------------------------------------------------------

        private void DrawToolbar()
        {
            EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);

            using (new EditorGUI.DisabledScope(busy))
            {
                if (GUILayout.Button("Refresh", EditorStyles.toolbarButton, GUILayout.Width(70f)))
                {
                    Refresh();
                }
            }

            GUILayout.Label("Registry:", EditorStyles.miniLabel, GUILayout.Width(56f));
            registryLocator = EditorGUILayout.TextField(registryLocator, EditorStyles.toolbarTextField);
            if (GUILayout.Button("Default", EditorStyles.toolbarButton, GUILayout.Width(60f)))
            {
                registryLocator = ResolveRegistryLocator();
            }

            // The engine is shown, not chosen. This window IS the Unity editor, so there
            // is no other engine it could honour -- the selector that used to sit here
            // allowed a Godot payload to be installed into a Unity project, because the
            // backend is engine-agnostic and takes the engine from its caller. A UI may
            // only offer what it can honour.
            //
            // It is displayed rather than removed because the value is passed to the
            // backend on every call, and a user comparing against `utool show` output
            // should be able to see which engine this window speaks for.
            GUILayout.Label("Engine: " + EngineName, EditorStyles.miniLabel, GUILayout.Width(90f));

            if (busy)
            {
                GUILayout.Label("working...", EditorStyles.miniLabel, GUILayout.Width(80f));
            }

            // Search sits at the right end of the toolbar with the rest of the
            // controls; the count next to it is what makes a filter's effect visible
            // ("3 of 4") instead of leaving a short list unexplained.
            GUILayout.FlexibleSpace();

            bool hadFocus = GUI.GetNameOfFocusedControl() == SearchControlName;
            GUI.SetNextControlName(SearchControlName);
            searchText = GUILayout.TextField(
                searchText ?? string.Empty,
                EditorStyles.toolbarSearchField,
                GUILayout.Width(180f));
            if (hadFocus && Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Escape)
            {
                searchText = string.Empty;
                GUI.FocusControl(null);
                Event.current.Use();
            }

            if (GUILayout.Button("Clear", EditorStyles.toolbarButton, GUILayout.Width(46f)))
            {
                searchText = string.Empty;
                GUI.FocusControl(null);
            }

            // Filter as one choice from a list. The previous boolean toggle could express
            // only "installed", so "show me what this engine can actually use" and "show
            // me what is NOT installed" had no expression at all.
            GUILayout.Label("Show:", EditorStyles.miniLabel, GUILayout.Width(36f));
            string[] filterLabels = { "All", "Installed", "Not installed", "This engine" };
            ToolFilter[] filterValues =
            {
                ToolFilter.All, ToolFilter.Installed, ToolFilter.NotInstalled, ToolFilter.ThisEngine,
            };
            int current = Array.IndexOf(filterValues, filter);
            int chosen = EditorGUILayout.Popup(current, filterLabels, EditorStyles.toolbarPopup, GUILayout.Width(110f));
            if (chosen >= 0 && chosen < filterValues.Length && chosen != current)
            {
                filter = filterValues[chosen];
            }

            int shown = VisibleTools().Count;
            GUILayout.Label(
                string.Format("{0}/{1}", shown, tools.Count),
                EditorStyles.miniLabel,
                GUILayout.Width(46f));

            EditorGUILayout.EndHorizontal();
        }

        // ------------------------------------------------------------------
        // list
        // ------------------------------------------------------------------

        private void DrawToolList()
        {
            EditorGUILayout.BeginVertical(GUILayout.Width(position.width * 0.38f));

            List<AvailableTool> visible = VisibleTools();
            EditorGUILayout.LabelField(
                string.Format("Tools ({0})", visible.Count),
                EditorStyles.boldLabel);

            listScroll = EditorGUILayout.BeginScrollView(listScroll, GUILayout.ExpandHeight(true));

            if (visible.Count == 0)
            {
                // Say WHICH kind of empty this is. "No tools" and "nothing matched your
                // filter" look identical otherwise, and the fix differs.
                EditorGUILayout.HelpBox(
                    tools.Count == 0
                        ? "The registry listed no tools."
                        : "No tool matches the current search or filter.",
                    MessageType.None);
            }

            foreach (AvailableTool tool in visible)
            {
                DrawToolRow(tool);
            }

            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();
        }

        /// <summary>
        /// One list row.
        /// </summary>
        /// <remarks>
        /// A row carries three facts the previous flat button could not: whether the tool
        /// is INSTALLED, whether this engine can use it, and whether installing it is
        /// supported at all. Each is drawn as a short prefix rather than a separate
        /// column, because the list is narrow and a prefix survives a resize.
        /// </remarks>
        private void DrawToolRow(AvailableTool tool)
        {
            bool selected = tool.Id == selectedId;
            bool installed = installedIds.Contains(tool.Id);

            string marker = installed ? "● " : "○ ";
            string suffix = tool.Supports(EngineName) ? string.Empty : "  [no " + EngineName + "]";

            var label = new GUIContent(
                marker + tool.DisplayName + "  " + tool.Version + suffix,
                tool.Id + "\n" + tool.Type +
                (installed ? "\ninstalled" : string.Empty) +
                "\nengines: " + tool.Engines +
                (string.IsNullOrEmpty(tool.Provides) ? string.Empty : "\nprovides: " + tool.Provides) +
                (string.IsNullOrEmpty(tool.Dependencies) ? string.Empty : "\ndepends on " + tool.Dependencies));

            // A row that cannot be installed is still SELECTABLE, so its detail pane can
            // explain why. Disabling the row would hide the explanation behind a control
            // the user cannot operate.
            //
            // While a command is in flight the row IS disabled, because clicking it would
            // be silently swallowed by Run's busy guard -- a click that does nothing is
            // worse than a click that is visibly unavailable.
            using (new EditorGUI.DisabledScope(busy))
            {
                if (GUILayout.Toggle(selected, label, "Button") != selected)
                {
                    Select(tool.Id);
                }
            }
        }

        // ------------------------------------------------------------------
        // details
        // ------------------------------------------------------------------

        private void DrawDetails()
        {
            EditorGUILayout.BeginVertical();

            if (string.IsNullOrEmpty(selectedId) || detailRecords == null)
            {
                EditorGUILayout.HelpBox("Select a tool to review it before installing.", MessageType.None);
                EditorGUILayout.EndVertical();
                return;
            }

            detailScroll = EditorGUILayout.BeginScrollView(detailScroll, GUILayout.ExpandHeight(true));

            EditorGUILayout.LabelField(detailRecords.Detail("displayName"), EditorStyles.boldLabel);
            EditorGUILayout.LabelField(detailRecords.Detail("id") + "  " + detailRecords.Detail("version"),
                EditorStyles.miniLabel);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Description", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(detailRecords.Detail("description"), EditorStyles.wordWrappedLabel);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Capabilities", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Engines: " + detailRecords.Detail("engines"));
            EditorGUILayout.LabelField(
                "Provides: " + (string.IsNullOrEmpty(detailRecords.Detail("provides"))
                    ? "(none)"
                    : detailRecords.Detail("provides")),
                EditorStyles.wordWrappedLabel);
            EditorGUILayout.LabelField(
                "Injects: " + (string.IsNullOrEmpty(detailRecords.Detail("injects"))
                    ? "(none)"
                    : detailRecords.Detail("injects")),
                EditorStyles.wordWrappedLabel);

            // Engine-specific requirements, rendered per engine from TARGET records.
            // The window deliberately does not name requirement keys: which keys
            // exist is the engine adapter's business, so it prints whatever the
            // backend reports and stays correct when an adapter adds one.
            //
            // Only THIS engine's targets are shown. The backend reports every engine a
            // tool declares, which is right for a shell that can install into any of
            // them; this window is the Unity editor and can install into Unity only.
            // Listing a Godot target invited exactly the confusion it caused - it read
            // as "this project has a Godot target" and led to selecting godot and
            // installing a Godot plugin into a Unity project. A cross-engine tool still
            // reports its other targets through `utool show`.
            var targets = new List<ToolTargetInfo>();
            foreach (string[] fields in detailRecords.Of("TARGET"))
            {
                ToolTargetInfo target = ToolTargetInfo.FromFields(fields);
                if (target.Engine == EngineName)
                {
                    targets.Add(target);
                }
            }

            if (targets.Count > 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Targets", EditorStyles.boldLabel);
                foreach (ToolTargetInfo target in targets)
                {
                    string marker = target.Engine == EngineName ? "> " : "  ";
                    EditorGUILayout.LabelField(
                        marker + target.Engine + "  (" + target.ArtifactType +
                        (string.IsNullOrEmpty(target.ArtifactFormat) ? string.Empty : "/" + target.ArtifactFormat) +
                        ")", EditorStyles.boldLabel);
                    EditorGUILayout.LabelField("    requirements: " + target.RequirementsSummary());

                    if (target.IsExternal)
                    {
                        EditorGUILayout.LabelField(
                            "    upstream: " + target.ExternalUrl + " @ " + target.ExternalRef,
                            EditorStyles.wordWrappedLabel);
                        // Stated here as a FACT about the target; the actionable warning
                        // sits next to the buttons. Saying it in both places read as two
                        // problems rather than one.
                        EditorGUILayout.LabelField(
                            "    metadata only - no artifact is stored in the registry",
                            EditorStyles.wordWrappedMiniLabel);
                    }
                    else if (!string.IsNullOrEmpty(target.ContentRoot))
                    {
                        EditorGUILayout.LabelField("    extracts into: " + target.ContentRoot);
                    }
                    else if (!string.IsNullOrEmpty(target.TargetPath))
                    {
                        EditorGUILayout.LabelField("    lands at: " + target.TargetPath);
                    }

                    if (target.EditorOnly)
                    {
                        EditorGUILayout.LabelField("    editor-only: excluded from player builds");
                    }
                }

                // State the cross-engine fact without offering it as an action. Hiding
                // it entirely would be its own kind of lie: a tool really does ship
                // another engine's target, and a user comparing `utool show` output
                // against this window would otherwise see a discrepancy and trust
                // neither.
                string otherEngines = OtherEngines(detailRecords);
                if (!string.IsNullOrEmpty(otherEngines))
                {
                    EditorGUILayout.LabelField(
                        "Also ships a target for: " + otherEngines +
                        " (not installable here - this window installs into " + EngineName + ").",
                        EditorStyles.wordWrappedMiniLabel);
                }
            }

            var dependencyLines = new List<string>();
            foreach (string[] dependency in detailRecords.Of("DEPENDENCY"))
            {
                if (dependency.Length >= 4)
                {
                    // Render the constraint in words. `^1.1.0` is semver shorthand that
                    // means "1.1.0 or newer, same major" -- meaningful to a resolver and
                    // opaque to the person deciding whether to install. The raw form is
                    // kept in the tooltip so nothing is hidden from someone who wants it.
                    string constraint = HumanConstraint(dependency[1]);
                    dependencyLines.Add(
                        "  " + dependency[0] + "  " + constraint +
                        "  (" + dependency[2] + ")" +
                        (string.IsNullOrEmpty(dependency[3]) ? string.Empty : " - " + dependency[3]));
                }
            }
            if (dependencyLines.Count > 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Dependencies", EditorStyles.boldLabel);
                foreach (string line in dependencyLines)
                {
                    EditorGUILayout.LabelField(line, EditorStyles.wordWrappedLabel);
                }
            }

            var files = new List<string>();
            foreach (string[] file in detailRecords.Of("WILLINSTALL"))
            {
                if (file.Length >= 1) files.Add(file[0]);
            }
            if (files.Count > 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField(string.Format("Installs {0} file(s)", files.Count), EditorStyles.boldLabel);
                foreach (string file in files)
                {
                    EditorGUILayout.LabelField("  " + file);
                }
            }

            if (failureRecords != null)
            {
                EditorGUILayout.Space();
                DrawFailures(failureRecords);
            }

            if (planRecords != null)
            {
                EditorGUILayout.Space();
                DrawPlan(planRecords);
            }

            EditorGUILayout.EndScrollView();

            // Actions are kept outside the scroll view so they are always reachable.
            EditorGUILayout.Space();

            // A tool whose target this build cannot install must not OFFER the action. The
            // backend reports an external/git target as caller-resolved and installs
            // nothing, so "Install" would appear to succeed while writing no files.
            //
            // The reason is stated ONCE, here, next to the disabled buttons -- the place a
            // user is looking when they wonder why the button is greyed out. It used to be
            // written twice (a full explanation in the Targets section and a second
            // paragraph here), which read as two separate problems and buried the one fact
            // that matters.
            bool installable = IsInstallableHere();
            if (!installable)
            {
                string reason = UninstallableReason();
                EditorGUILayout.HelpBox(
                    "Cannot install this tool.\n\n" + reason,
                    MessageType.Warning);
            }

            EditorGUILayout.BeginHorizontal();
            using (new EditorGUI.DisabledScope(busy || !installable))
            {
                if (GUILayout.Button("Verify and plan (writes nothing)"))
                {
                    Plan(false);
                }
                using (new EditorGUI.DisabledScope(planRecords == null))
                {
                    if (GUILayout.Button("Install"))
                    {
                        Install();
                    }
                }
            }

            // Uninstall stays available regardless: a tool that is ALREADY installed
            // must always be removable, even if this build would no longer install it.
            // Blocking removal would trap the user with files they cannot get rid of.
            using (new EditorGUI.DisabledScope(
                busy || !installedIds.Contains(selectedId) || string.IsNullOrEmpty(selectedId)))
            {
                if (GUILayout.Button(
                        installedIds.Contains(selectedId) ? "Uninstall..." : "Uninstall (not installed)"))
                {
                    Uninstall();
                }
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.EndVertical();
        }

        /// <summary>
        /// Can this window actually install the selected tool's target?
        /// </summary>
        /// <remarks>
        /// False when this engine's target is an `external` source (git, for example):
        /// the backend deliberately reports it as caller-resolved and writes nothing.
        /// Also false when the tool declares no target for this engine at all.
        /// </remarks>
        private bool IsInstallableHere()
        {
            ToolTargetInfo mine = FindMyTarget();
            return mine != null && !mine.IsExternal;
        }

        /// <summary>
        /// Why the install buttons are disabled, phrased for the user.
        /// </summary>
        /// <remarks>
        /// One place produces this text, so the panel cannot drift out of step with the
        /// buttons it explains.
        /// </remarks>
        private string UninstallableReason()
        {
            ToolTargetInfo mine = FindMyTarget();
            if (mine == null)
            {
                return "This tool declares no target for " + EngineName + ".";
            }
            if (mine.IsExternal)
            {
                return
                    "Its code lives in an upstream repository, not in the registry:\n" +
                    mine.ExternalUrl + (string.IsNullOrEmpty(mine.ExternalRef) ? string.Empty : " @ " + mine.ExternalRef) +
                    "\n\nThe backend reports this target without resolving it, so installing it here " +
                    "would appear to succeed while writing nothing.\n\n" +
                    "Add it to the project manually, or wait for external-source support.";
            }
            return "This tool cannot be installed by this window.";
        }

        /// <summary>This engine's target for the selected tool, or null.</summary>
        private ToolTargetInfo FindMyTarget()
        {
            if (detailRecords == null) return null;
            foreach (string[] fields in detailRecords.Of("TARGET"))
            {
                ToolTargetInfo candidate = ToolTargetInfo.FromFields(fields);
                if (candidate.Engine == EngineName) return candidate;
            }
            return null;
        }

        /// <summary>
        /// Render a failed command's problems.
        /// </summary>
        /// <remarks>
        /// Selectable so the message can be copied out. A digest mismatch quotes two
        /// 64-character hashes, and retyping those by hand is not something to ask of
        /// anybody. The code is shown too, because it is what a bug report or a search
        /// through the error-code reference needs.
        /// </remarks>
        private void DrawFailures(BackendRecords records)
        {
            List<string> problems = records.Problems();
            EditorGUILayout.LabelField("Could not complete", EditorStyles.boldLabel);

            if (problems.Count == 0)
            {
                EditorGUILayout.HelpBox(
                    "The backend failed without reporting a reason.",
                    MessageType.Error);
                return;
            }

            foreach (string problem in problems)
            {
                // Problems arrive as "CODE\tmessage"; split so the code can be shown as
                // the headline and the detail selectable underneath.
                int separator = problem.IndexOf(':');
                string code = separator > 0 ? problem.Substring(0, separator) : problem;
                string message = separator > 0 ? problem.Substring(separator + 1).Trim() : string.Empty;

                EditorGUILayout.HelpBox(code, MessageType.Error);
                if (message.Length > 0)
                {
                    EditorGUILayout.SelectableLabel(
                        message,
                        EditorStyles.textArea,
                        GUILayout.MinHeight(
                            EditorStyles.textArea.CalcHeight(new GUIContent(message), position.width) + 4f));
                }
            }
        }

        /// <summary>
        /// Turn a version constraint into words a user can act on.
        /// </summary>
        /// <remarks>
        /// `^1.1.0` and `~1.1.0` are semver notation. They belong in a manifest and in
        /// resolver code; showing them raw in a UI asks the reader to know that `^` means
        /// "same major, at least this" and `~` means "same major and minor". An empty
        /// constraint means any version, which is also worth saying out loud.
        /// </remarks>
        internal static string HumanConstraint(string constraint)
        {
            if (string.IsNullOrEmpty(constraint)) return "any version";

            string text = constraint.Trim();

            // Two-character operators first: `>=1.2.0` must not be read as `>` applied to
            // `=1.2.0`, which is what stripping one character unconditionally did.
            if (text.StartsWith(">=")) return text.Substring(2) + " or newer";
            if (text.StartsWith("<=")) return text.Substring(2) + " or older";

            string version = text.Substring(1);

            switch (text[0])
            {
                case '^':
                    return version + " or newer (same major)";
                case '~':
                    return version + " or newer (same major.minor)";
                case '>':
                    return "newer than " + version;
                case '<':
                    return "older than " + version;
                case '=':
                    return "exactly " + version;
                default:
                    // A bare version is an exact requirement unless it is a range list.
                    return text.Contains(" ") ? text : "exactly " + text;
            }
        }

        /// <summary>
        /// Engines this tool declares that this window cannot install into.
        /// </summary>
        /// <remarks>
        /// Reported, never offered. The distinction matters: the previous UI listed the
        /// Godot target with a selectable engine toggle, which read as an invitation and
        /// let a Godot plugin be installed into a Unity project.
        /// </remarks>
        private string OtherEngines(BackendRecords records)
        {
            var others = new List<string>();
            foreach (string[] fields in records.Of("TARGET"))
            {
                if (fields.Length > 0 && fields[0] != EngineName && !others.Contains(fields[0]))
                {
                    others.Add(fields[0]);
                }
            }
            others.Sort();
            return string.Join(", ", others.ToArray());
        }

        /// <summary>Render the plan and its verification outcome.</summary>
        private static void DrawPlan(BackendRecords plan)
        {
            List<string> problems = plan.Problems();
            if (problems.Count > 0)
            {
                var text = new StringBuilder();
                foreach (string problem in problems)
                {
                    text.AppendLine(problem);
                }
                EditorGUILayout.HelpBox(text.ToString(), MessageType.Error);
                return;
            }

            bool ok = plan.ResultBool("ok");
            EditorGUILayout.HelpBox(
                ok
                    ? "Verification passed: every artifact matches its declared size and sha256."
                    : "The plan was NOT verified: the backend reported ok=false. Do not install until " +
                      "this is understood.",
                ok ? MessageType.Info : MessageType.Error);

            foreach (string[] tool in plan.Of("PLANTOOL"))
            {
                // PLANTOOL: id version engine artifactType artifactFormat size sha256
                //           contentRoot editorOnly installedBecause skipped
                if (tool.Length < 3) continue;
                string skipped = tool.Length > 10 ? tool[10] : string.Empty;
                if (!string.IsNullOrEmpty(skipped))
                {
                    EditorGUILayout.LabelField(
                        tool[0] + "/" + tool[2] + ": " + skipped, EditorStyles.wordWrappedMiniLabel);
                    continue;
                }

                string artifact = tool.Length > 3 ? tool[3] : "?";
                if (tool.Length > 4 && !string.IsNullOrEmpty(tool[4])) artifact += "/" + tool[4];
                EditorGUILayout.LabelField(
                    string.Format("{0} {1} [{2}] {3} - {4} bytes - needed by {5}",
                        tool[0], tool[1], tool[2], artifact,
                        tool.Length > 5 ? tool[5] : "?",
                        tool.Length > 9 && !string.IsNullOrEmpty(tool[9]) ? tool[9] : "user"),
                    EditorStyles.boldLabel);
            }

            // What each engine would actually receive. Reported per tool+engine so a
            // cross-engine install does not blend two engines' destinations.
            foreach (string[] file in plan.Of("PLANFILE"))
            {
                if (file.Length >= 2) EditorGUILayout.LabelField("    " + file[0] + " -> " + file[1]);
            }
        }

        // ------------------------------------------------------------------
        // actions
        // ------------------------------------------------------------------

        private void Refresh()
        {
            Run("list", records =>
            {
                var loaded = new List<AvailableTool>();
                foreach (string[] fields in records.Of("TOOL"))
                {
                    loaded.Add(AvailableTool.FromFields(fields));
                }

                // Publish only after the call succeeded, so a failed refresh cannot
                // replace a good listing with an empty one.
                cachedTools = loaded;
                cachedRegistryLocator = registryLocator;
                statusMessage = string.Format("Registry: {0} - {1} tool(s).", registryLocator, tools.Count);
            });
        }

        private void Select(string id)
        {
            selectedId = id;
            planRecords = null;
            Run("show \"" + id + "\"", records =>
            {
                detailRecords = records;
                statusMessage = "Review the requirements, then verify the plan.";
            });
        }

        private void Plan(bool dryRun)
        {
            if (string.IsNullOrEmpty(selectedId)) return;
            Run("plan \"" + selectedId + "\"", records =>
            {
                planRecords = records;
                List<string> problems = records.Problems();
                statusMessage = problems.Count == 0
                    ? "Plan verified. Nothing has been written yet."
                    : string.Format("Plan rejected: {0} problem(s). See the panel.", problems.Count);
            }, dryRun);
        }

        private void Install()
        {
            if (string.IsNullOrEmpty(selectedId)) return;
            if (!EditorUtility.DisplayDialog(
                    "Install " + selectedId + "?",
                    "The plan above was verified. Files will be written and a receipt recorded so this can be " +
                    "uninstalled cleanly.",
                    "Install",
                    "Cancel"))
            {
                return;
            }

            Run("install \"" + selectedId + "\"", records =>
            {
                int installed = 0;
                foreach (string[] ignored in records.Of("INSTALLED"))
                {
                    installed++;
                }
                statusMessage = string.Format("{0} tool(s) installed. Receipts recorded under Library/.", installed);
                planRecords = null;
                // Queued: calling this directly would hit Run while busy is still set.
                QueueCommand(() => RefreshInstalled());
                AssetDatabase.Refresh();
            });
        }

        /// <summary>
        /// Uninstall the selected tool, confirming by file count first.
        /// </summary>
        /// <remarks>
        /// The confirmation names the tool, not the file list: a receipt can cover
        /// dozens of files and a wall of paths in a dialog is read by nobody. What a
        /// user needs to decide is "was this the tool I meant", and the count tells
        /// them the size of the change.
        /// </remarks>
        private void Uninstall()
        {
            if (string.IsNullOrEmpty(selectedId)) return;

            if (!EditorUtility.DisplayDialog(
                    "Uninstall " + selectedId + "?",
                    "Files this tool installed will be removed, and its receipt cleared. Files still " +
                    "claimed by another installed tool are kept. This cannot be undone from here, but " +
                    "reinstalling restores the original files.",
                    "Uninstall",
                    "Cancel"))
            {
                return;
            }

            Run("uninstall \"" + selectedId + "\"", records =>
            {
                int removed = 0;
                foreach (string[] ignored in records.Of("REMOVED"))
                {
                    removed++;
                }
                statusMessage = string.Format(
                    "{0} file(s) removed for {1}.", removed, selectedId);
                detailRecords = null;
                planRecords = null;
                // Queued for the same reason as install.
                QueueCommand(() => RefreshInstalled());
                AssetDatabase.Refresh();
            });
        }

        /// <summary>
        /// Run a command against the backend and hand the parsed records back.
        /// </summary>
        /// <param name="arguments">Command plus arguments, without --registry/--project.</param>
        /// <param name="onSuccess">Called with the parsed records when the CLI succeeded.</param>
        /// <param name="dryRun">Set for commands that must not write.</param>
        private async void Run(string arguments, Action<BackendRecords> onSuccess, bool dryRun = false)
        {
            if (busy)
            {
                return;
            }

            busy = true;
            try
            {
                string projectRoot = Directory.GetParent(Application.dataPath).FullName;
                var command = new StringBuilder();
                command.Append(arguments);
                command.Append(" --registry \"").Append(registryLocator).Append('"');
                command.Append(" --project \"").Append(projectRoot).Append('"');
                // Which engine the backend should plan for. Required: the core knows
                // no engine, so without this it cannot decide which target applies.
                command.Append(" --engine \"").Append(EngineName).Append('"');
                // Declaring the host lets the adapter enforce package floors.
                command.Append(" --host-unity \"").Append(Application.unityVersion).Append('"');
                if (dryRun)
                {
                    command.Append(" --dry-run");
                }
                command.Append(" --records");

                CliRunner.CliResult result = await CliRunner.RunAsync(command.ToString(), projectRoot);
                var records = BackendRecords.Parse(result.StdOut);

                if (result.ExitCode != 0)
                {
                    List<string> problems = records.Problems();
                    statusMessage = problems.Count > 0
                        ? string.Format("{0} problem(s). See the panel.", problems.Count)
                        : (string.IsNullOrEmpty(result.StdErr) ? "Backend failed." : result.StdErr);

                    // Keep the problems visible in the details pane. Showing only
                    // problems[0] in the bottom status line meant a failed verification
                    // reported "Backend failed." with no reason anywhere -- and the reason
                    // is the only part a user can act on.
                    failureRecords = records;
                    return;
                }

                // A successful call clears a previous failure, or a stale error would sit
                // in the panel contradicting the list beside it.
                failureRecords = null;
                onSuccess(records);
            }
            catch (Exception exception)
            {
                statusMessage = "Backend call failed: " + exception.Message;
                Debug.LogException(exception);
            }
            finally
            {
                // Clear `busy` BEFORE repainting, and note that the callback above runs
                // while it was still set.
                //
                // That is the whole reason the window hung on "Loading the registry...":
                // a callback that starts another command ran while busy was true, so Run
                // dropped it silently. Chaining calls through a callback only works if
                // the callback runs ONCE THE PREVIOUS CALL IS FINISHED -- otherwise it is
                // the same collision in a new shape.
                //
                // Callbacks that need to queue more work must therefore do it after this
                // returns. `QueueCommand` exists for exactly that.
                busy = false;
                FlushQueue();
                Repaint();
            }
        }

        /// <summary>
        /// Run a command after the current one finishes.
        /// </summary>
        /// <remarks>
        /// Necessary because `Run` refuses to start while `busy`, and a callback invoked
        /// from inside `Run` still sees `busy == true`. Queuing defers the work to the
        /// `finally` block, which is the first point at which starting a new command is
        /// actually allowed.
        /// </remarks>
        private void QueueCommand(Action command)
        {
            if (command == null || queuedCommand != null) return;
            queuedCommand = command;
        }

        /// <summary>Start whatever was queued, now that no command is in flight.</summary>
        private void FlushQueue()
        {
            Action next = queuedCommand;
            queuedCommand = null;
            if (next != null) next();
        }

        /// <summary>
        /// Where to read the registry from.
        /// </summary>
        /// <remarks>
        /// Order: the UTOOL_REGISTRY environment variable, a sibling checkout of
        /// the registry repository (how this is used while developing), then the
        /// published GitHub raw URL so a fresh clone of the tool just works.
        /// </remarks>
        private static string ResolveRegistryLocator()
        {
            string fromEnvironment = Environment.GetEnvironmentVariable(RegistryPathVariable);
            if (!string.IsNullOrEmpty(fromEnvironment))
            {
                return fromEnvironment;
            }

            var directory = new DirectoryInfo(Application.dataPath);
            for (int depth = 0; directory != null && depth < 6; depth++)
            {
                string candidate = Path.Combine(directory.FullName, "DevCatToolRegistry");
                if (Directory.Exists(Path.Combine(candidate, "payloads")))
                {
                    return candidate;
                }
                directory = directory.Parent;
            }

            return DefaultRemoteRegistry;
        }
    }
}
