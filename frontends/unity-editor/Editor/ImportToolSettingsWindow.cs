using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace DevCat.ToolImport.Editor
{
    /// <summary>
    /// Editor settings for the import tool, in their own window.
    /// </summary>
    /// <remarks>
    /// Kept OUT of the main window so that adding a setting cannot disturb the layout
    /// there. The main window is about browsing and installing tools; where the registry
    /// lives is configuration, looked at rarely and changed rarely, and putting the two in
    /// one place means every new option competes with the tool list for room.
    ///
    /// Settings are stored in EditorPrefs, so they are per-USER and per-MACHINE rather
    /// than per-project. That is deliberate: paths to a checkout are a property of the
    /// machine, and committing them would break every other developer's setup.
    /// </remarks>
    internal sealed class ImportToolSettingsWindow : EditorWindow
    {
        /// <summary>EditorPrefs key holding an explicit registry location.</summary>
        internal const string RegistryPrefKey = "DevCat.ToolImport.Registry";

        /// <summary>EditorPrefs key holding an explicit utool CLI path.</summary>
        internal const string CliPrefKey = "DevCat.ToolImport.Cli";

        /// <summary>EditorPrefs key for the node executable, when not on PATH.</summary>
        internal const string NodePrefKey = "DevCat.ToolImport.Node";

        private string registryOverride;
        private string cliOverride;
        private string nodeOverride;

        [MenuItem("Window/DevCatToolRegistry/Settings", priority = 1201)]
        internal static void Open()
        {
            var window = GetWindow<ImportToolSettingsWindow>();
            window.titleContent = new GUIContent("Import Tool Settings");
            window.minSize = new Vector2(460f, 220f);
            window.Show();
        }

        private void OnEnable()
        {
            registryOverride = EditorPrefs.GetString(RegistryPrefKey, string.Empty);
            cliOverride = EditorPrefs.GetString(CliPrefKey, string.Empty);
            nodeOverride = EditorPrefs.GetString(NodePrefKey, string.Empty);
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Import tool settings", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(
                "Stored per user and per machine, not in the project. Leave a field empty to " +
                "use the automatic behaviour.",
                EditorStyles.wordWrappedMiniLabel);

            EditorGUILayout.Space();

            registryOverride = DrawPathField(
                "Registry",
                registryOverride,
                "Where the tool registry lives. Empty means: an UTOOL_REGISTRY environment " +
                "variable, then a sibling checkout, then the published URL.");

            EditorGUILayout.Space();

            cliOverride = DrawPathField(
                "utool CLI",
                cliOverride,
                "Path to apps/cli/bin/utool.js. Empty means: an UTOOL_CLI environment " +
                "variable, then a sibling checkout of the import tool.");

            EditorGUILayout.Space();

            nodeOverride = DrawPathField(
                "Node",
                nodeOverride,
                "Path to the node executable. Empty means: whatever 'node' resolves to on PATH.");

            EditorGUILayout.Space();
            DrawResolved();

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Save"))
                {
                    EditorPrefs.SetString(RegistryPrefKey, registryOverride ?? string.Empty);
                    EditorPrefs.SetString(CliPrefKey, cliOverride ?? string.Empty);
                    EditorPrefs.SetString(NodePrefKey, nodeOverride ?? string.Empty);
                    // The main window caches its listing against a locator, so a change
                    // here must invalidate that or the old listing would survive the edit.
                    ImportToolWindow.ForgetCachedListing();
                    Debug.Log("DevCat import tool: settings saved.");
                }

                if (GUILayout.Button("Clear all"))
                {
                    registryOverride = string.Empty;
                    cliOverride = string.Empty;
                    nodeOverride = string.Empty;
                    EditorPrefs.DeleteKey(RegistryPrefKey);
                    EditorPrefs.DeleteKey(CliPrefKey);
                    EditorPrefs.DeleteKey(NodePrefKey);
                    ImportToolWindow.ForgetCachedListing();
                }

                GUILayout.FlexibleSpace();

                if (GUILayout.Button("Close"))
                {
                    Close();
                }
            }
        }

        /// <summary>One labelled path with a Browse button.</summary>
        private static string DrawPathField(string label, string value, string help)
        {
            EditorGUILayout.LabelField(label, EditorStyles.boldLabel);
            EditorGUILayout.LabelField(help, EditorStyles.wordWrappedMiniLabel);

            string result;
            using (new EditorGUILayout.HorizontalScope())
            {
                result = EditorGUILayout.TextField(value ?? string.Empty);

                // A file browser for the two file fields; the registry may be a URL, so
                // its Browse button offers a folder instead and is labelled accordingly.
                if (GUILayout.Button("Browse...", GUILayout.Width(80f)))
                {
                    string chosen = label == "Registry"
                        ? EditorUtility.OpenFolderPanel("Select the registry folder", string.Empty, string.Empty)
                        : EditorUtility.OpenFilePanel("Select the file", string.Empty, string.Empty);
                    if (!string.IsNullOrEmpty(chosen)) result = chosen;
                }

                if (GUILayout.Button("Clear", GUILayout.Width(52f)))
                {
                    result = string.Empty;
                }
            }
            return result;
        }

        /// <summary>
        /// Show what the automatic resolution actually finds.
        /// </summary>
        /// <remarks>
        /// Without this, "empty means automatic" leaves the user guessing whether the
        /// automatic path worked. Naming the resolved value turns a silent fallback into
        /// something they can verify.
        /// </remarks>
        private void DrawResolved()
        {
            EditorGUILayout.LabelField("Resolved now", EditorStyles.boldLabel);

            string cli = CliRunner.ResolveCliPath();
            EditorGUILayout.LabelField(
                "CLI: " + (string.IsNullOrEmpty(cli) ? "NOT FOUND" : cli),
                EditorStyles.wordWrappedMiniLabel);

            string registry = ImportToolWindow.ResolveRegistryLocatorForDisplay();
            EditorGUILayout.LabelField(
                "Registry: " + (string.IsNullOrEmpty(registry) ? "NOT FOUND" : registry),
                EditorStyles.wordWrappedMiniLabel);

            if (string.IsNullOrEmpty(cli))
            {
                EditorGUILayout.HelpBox(
                    "The backend CLI was not found, so the main window cannot do anything. " +
                    "Set it above, or place a UnityToolImport checkout beside this project.",
                    MessageType.Error);
            }
        }
    }
}
