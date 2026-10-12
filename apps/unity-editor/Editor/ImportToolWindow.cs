using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace DevCat.UnityDevCommonLib.ImportTool.Editor
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
            "https://raw.githubusercontent.com/JokeVallen/UnityDevCommonLib/main";

        private readonly List<AvailableTool> tools = new List<AvailableTool>();
        private Vector2 listScroll;
        private Vector2 detailScroll;
        private string selectedId = string.Empty;
        private string registryLocator = string.Empty;
        private string statusMessage = "Press Refresh to list the registry.";
        private BackendRecords detailRecords;
        private BackendRecords planRecords;
        private bool busy;

        [MenuItem("Window/UnityDevCommonLib/工具库导入工具 (Import Tool)", priority = 1200)]
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
                var label = new GUIContent(
                    tool.DisplayName + "  " + tool.Version + (tool.IsExternal ? "  [external]" : string.Empty),
                    tool.Id + "\n" + tool.Type +
                    "\nmin Unity " + tool.MinUnityVersion + ", min .NET " + tool.MinDotNetVersion +
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
            EditorGUILayout.LabelField("Requirements", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Minimum Unity: " + detailRecords.Detail("minUnityVersion"));
            EditorGUILayout.LabelField("Minimum .NET API level: " + detailRecords.Detail("minDotNetVersion"));
            EditorGUILayout.LabelField("Source: " + detailRecords.Detail("sourceKind") +
                " (" + detailRecords.Detail("sourceType") + ")");

            if (detailRecords.Detail("sourceKind") == "external")
            {
                EditorGUILayout.LabelField("Upstream: " + detailRecords.Detail("gitUrl") +
                    " @ " + detailRecords.Detail("gitRef"), EditorStyles.wordWrappedLabel);
                EditorGUILayout.HelpBox(
                    "This entry stores metadata only. The import tool does not fetch git remotes itself: " +
                    "the backend resolves the source through the caller and records the result in the receipt.",
                    MessageType.Info);
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
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.EndVertical();
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
                    : "The plan could not be verified.",
                ok ? MessageType.Info : MessageType.Error);

            foreach (string[] tool in plan.Of("PLANTOOL"))
            {
                if (tool.Length < 2) continue;
                string skipped = tool.Length > 9 ? tool[9] : string.Empty;
                if (!string.IsNullOrEmpty(skipped))
                {
                    EditorGUILayout.LabelField(tool[0] + ": " + skipped, EditorStyles.wordWrappedMiniLabel);
                    continue;
                }

                EditorGUILayout.LabelField(
                    string.Format("{0} {1} - {2} bytes - needed by {3}",
                        tool[0], tool[1], tool.Length > 3 ? tool[3] : "?", tool.Length > 8 ? tool[8] : "user"),
                    EditorStyles.boldLabel);
            }
        }

        // ------------------------------------------------------------------
        // actions
        // ------------------------------------------------------------------

        private void Refresh()
        {
            Run("list", records =>
            {
                tools.Clear();
                foreach (string[] fields in records.Of("TOOL"))
                {
                    tools.Add(AvailableTool.FromFields(fields));
                }
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
                // Declaring the host lets the backend enforce package floors.
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
                string candidate = Path.Combine(directory.FullName, "UnityDevCommonLib");
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
