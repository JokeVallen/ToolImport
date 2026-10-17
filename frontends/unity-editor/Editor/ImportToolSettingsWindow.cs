using System;
using UnityEditor;
using UnityEngine;

namespace ToolImport.Editor
{
    internal sealed class ImportToolSettingsWindow : EditorWindow
    {
        /// <summary>EditorPrefs key holding an explicit registry location.</summary>
        internal const string REGISTRY_PREF_KEY = "ToolImport.Registry";

        /// <summary>EditorPrefs key holding an explicit utool CLI path.</summary>
        internal const string CLI_PREF_KEY = "ToolImport.Cli";

        /// <summary>EditorPrefs key for the node executable, when not on PATH.</summary>
        internal const string NODE_PREF_KEY = "ToolImport.Node";

        private static readonly Type[] desiredDockNextTo = new Type[] { typeof(ImportToolWindow) };
        private string registryOverride;
        private string cliOverride;
        private string nodeOverride;

        internal static void Open()
        {
            var window = GetWindow<ImportToolSettingsWindow>(desiredDockNextTo: desiredDockNextTo);
            window.titleContent = new GUIContent(nameof(ImportToolSettingsWindow));
            window.minSize = new Vector2(460f, 220f);
            window.Show();
        }

        private void OnEnable()
        {
            registryOverride = EditorPrefs.GetString(REGISTRY_PREF_KEY, string.Empty);
            cliOverride = EditorPrefs.GetString(CLI_PREF_KEY, string.Empty);
            nodeOverride = EditorPrefs.GetString(NODE_PREF_KEY, string.Empty);
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Import tool settings", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Stored per user and per machine, not in the project. Leave a field empty to use the automatic behaviour.",
            EditorStyles.wordWrappedMiniLabel);

            EditorGUILayout.Space();

            registryOverride = DrawPathField("Registry", registryOverride,
            "Where the tool registry lives. Empty means: an UTOOL_REGISTRY environment variable, then a sibling checkout, then the published URL.");

            EditorGUILayout.Space();

            cliOverride = DrawPathField("utool CLI", cliOverride,
            "Path to apps/cli/bin/utool.js. Empty means: an UTOOL_CLI environment variable, then a sibling checkout of the import tool.");

            EditorGUILayout.Space();

            nodeOverride = DrawPathField("Node", nodeOverride,
            "Path to the node executable. Empty means: whatever 'node' resolves to on PATH.");

            EditorGUILayout.Space();
            DrawResolved();

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Save"))
                {
                    EditorPrefs.SetString(REGISTRY_PREF_KEY, registryOverride ?? string.Empty);
                    EditorPrefs.SetString(CLI_PREF_KEY, cliOverride ?? string.Empty);
                    EditorPrefs.SetString(NODE_PREF_KEY, nodeOverride ?? string.Empty);
                    ImportToolWindow.ForgetCachedListing();
                    Debug.Log($"{nameof(ImportToolSettingsWindow)}: settings saved.");
                }

                if (GUILayout.Button("Clear all"))
                {
                    registryOverride = string.Empty;
                    cliOverride = string.Empty;
                    nodeOverride = string.Empty;
                    EditorPrefs.DeleteKey(REGISTRY_PREF_KEY);
                    EditorPrefs.DeleteKey(CLI_PREF_KEY);
                    EditorPrefs.DeleteKey(NODE_PREF_KEY);
                    ImportToolWindow.ForgetCachedListing();
                }
            }
        }

        private static string DrawPathField(string label, string value, string help)
        {
            EditorGUILayout.LabelField(label, EditorStyles.boldLabel);
            EditorGUILayout.LabelField(help, EditorStyles.wordWrappedMiniLabel);

            string result;
            using (new EditorGUILayout.HorizontalScope())
            {
                result = EditorGUILayout.TextField(value ?? string.Empty);
                if (GUILayout.Button("Browse", GUILayout.Width(80f)))
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
                EditorGUILayout.HelpBox("The backend CLI was not found, so the main window cannot do anything. " +
                    "Set it above, or place a ToolImport checkout beside this project.",
                    MessageType.Error);
            }
        }
    }
}
