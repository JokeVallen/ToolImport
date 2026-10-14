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
        /// Engines this front end offers.
        /// </summary>
        /// <remarks>
        /// Unity only. This window IS the Unity editor: offering another engine let a
        /// user install a Godot plugin into a Unity project, which "succeeded" because
        /// the backend is deliberately engine-agnostic and takes the engine from the
        /// caller. The backend still supports several engines -- that is what the
        /// adapter split is for, and a Godot front end or a shell can pass its own --
        /// but a UI may only offer what it can honour.
        /// </remarks>
        private static readonly string[] CandidateEngines = { "unity" };

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
        private bool busy;

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

            // Know what is installed before drawing, so Uninstall is disabled for a
            // tool that is not there. This is a local read of the receipts, not a
            // registry request, so it is cheap on every open.
            RefreshInstalled();

            // Show the cached listing immediately, and refresh in the background when
            // there is nothing cached yet. On a reopen this is instant and silent; on a
            // first open it fills itself instead of showing an empty pane that says
            // "press Refresh".
            if (cachedTools != null && cachedTools.Count > 0)
            {
                statusMessage = string.Format("Registry: {0} - {1} tool(s).", registryLocator, cachedTools.Count);
            }
            else
            {
                statusMessage = "Loading the registry...";
                Refresh();
            }
        }

        /// <summary>Re-read which tools this project has installed.</summary>
        private void RefreshInstalled()
        {
            Run("status", records =>
            {
                installedIds.Clear();
                foreach (string[] fields in records.Of("RECEIPT"))
                {
                    if (fields.Length > 0) installedIds.Add(fields[0]);
                }
            });
        }

        private void OnGUI()
        {
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

            // Which engine to install into. This front end is the Unity one, so
            // unity is the default, but the backend is engine-agnostic and a tool
            // may target several engines. Choosing one here is what makes a
            // cross-engine tool's other targets visible instead of invisible.
            // The engine selector appears only when there is a choice to make. With a
            // single engine it was a control that could only do harm.
            if (CandidateEngines.Length > 1)
            {
                GUILayout.Label("Engine:", EditorStyles.miniLabel, GUILayout.Width(48f));
                foreach (string engine in CandidateEngines)
                {
                    bool active = engine == EngineName;
                    if (GUILayout.Toggle(active, engine, EditorStyles.toolbarButton, GUILayout.Width(60f)) && !active)
                    {
                        EngineName = engine;
                        // The selection is engine-specific, so the plan from the other
                        // engine must not be shown as if it still applied.
                        planRecords = null;
                        if (!string.IsNullOrEmpty(selectedId))
                        {
                            Select(selectedId);
                        }
                    }
                }
            }

            if (busy)
            {
                GUILayout.Label("working...", EditorStyles.miniLabel, GUILayout.Width(80f));
            }

            EditorGUILayout.EndHorizontal();
        }

        // ------------------------------------------------------------------
        // list
        // ------------------------------------------------------------------

        private void DrawToolList()
        {
            EditorGUILayout.BeginVertical(GUILayout.Width(position.width * 0.42f));
            EditorGUILayout.LabelField(string.Format("Available ({0})", tools.Count), EditorStyles.boldLabel);

            listScroll = EditorGUILayout.BeginScrollView(listScroll, GUILayout.ExpandHeight(true));
            foreach (AvailableTool tool in tools)
            {
                bool selected = tool.Id == selectedId;

                // The tooltip is engine-neutral on purpose: engine floors live in
                // TARGET records, and this list does not fetch them. Adding a
                // per-engine tooltip here would mean issuing `show` for every row.
                var label = new GUIContent(
                    tool.DisplayName + "  " + tool.Version +
                        (tool.Supports(EngineName) ? string.Empty : "  [not " + EngineName + "]"),
                    tool.Id + "\n" + tool.Type +
                    "\nengines: " + tool.Engines +
                    (string.IsNullOrEmpty(tool.Provides) ? string.Empty : "\nprovides: " + tool.Provides) +
                    (string.IsNullOrEmpty(tool.Dependencies) ? string.Empty : "\ndepends on " + tool.Dependencies));

                // Unity has a string-style overload for GUILayout.Toggle, which
                // avoids constructing a GUIStyle just to get a list row look.
                if (GUILayout.Toggle(selected, label, "Button") != selected)
                {
                    Select(tool.Id);
                }
            }
            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();
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
                    string marker = target.Engine == EngineName ? "> " : "  ";                    EditorGUILayout.LabelField(
                        marker + target.Engine + "  (" + target.ArtifactType +
                        (string.IsNullOrEmpty(target.ArtifactFormat) ? string.Empty : "/" + target.ArtifactFormat) +
                        ")", EditorStyles.boldLabel);
                    EditorGUILayout.LabelField("    requirements: " + target.RequirementsSummary());

                    if (target.IsExternal)
                    {
                        EditorGUILayout.LabelField(
                            "    upstream: " + target.ExternalUrl + " @ " + target.ExternalRef,
                            EditorStyles.wordWrappedLabel);
                        EditorGUILayout.HelpBox(
                            "This target stores metadata only: no artifact lives in the registry. The backend " +
                            "reports it as caller-resolved rather than fetching it, and the receipt records the " +
                            "url and ref so the source can be audited later.",
                            MessageType.Info);
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
                    dependencyLines.Add("  " + dependency[0] + " " + dependency[1] +
                        " (" + dependency[2] + ")" +
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

            if (planRecords != null)
            {
                EditorGUILayout.Space();
                DrawPlan(planRecords);
            }

            EditorGUILayout.EndScrollView();

            // Actions are kept outside the scroll view so they are always reachable.
            EditorGUILayout.Space();
            EditorGUILayout.BeginHorizontal();
            using (new EditorGUI.DisabledScope(busy))
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
                // Uninstall is its own action, not a mode of Install: it acts on
                // what a RECEIPT says is installed, and asks for its own confirmation
                // because it deletes files.
                //
                // Disabled for a tool with no receipt: offering it invited a click that
                // could only produce "no receipt for X", which reads as a broken tool
                // rather than as "this was never installed".
                using (new EditorGUI.DisabledScope(
                    !installedIds.Contains(selectedId) || string.IsNullOrEmpty(selectedId)))
                {
                    if (GUILayout.Button(
                            installedIds.Contains(selectedId) ? "Uninstall..." : "Uninstall (not installed)"))
                    {
                        Uninstall();
                    }
                }
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.EndVertical();
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
                RefreshInstalled();
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
                RefreshInstalled();
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
                        ? problems[0]
                        : (string.IsNullOrEmpty(result.StdErr) ? "Backend failed." : result.StdErr);
                    if (problems.Count > 0)
                    {
                        // Keep the problems visible in the details pane.
                        planRecords = records;
                    }
                    return;
                }

                onSuccess(records);
            }
            catch (Exception exception)
            {
                statusMessage = "Backend call failed: " + exception.Message;
                Debug.LogException(exception);
            }
            finally
            {
                busy = false;
                Repaint();
            }
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
