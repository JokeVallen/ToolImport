using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace ToolImport.Editor
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
        private const string REGISTRY_PATH_VARIABLE = "UTOOL_REGISTRY";
        private const string DEFAULT_REMOTE_REGISTRY = "https://raw.githubusercontent.com/JokeVallen/ToolRegistry/main";

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
        /// The listing's VERSIONS records, cached with the listing they belong to.
        /// </summary>
        /// <remarks>
        /// The version rows under a selected tool read this, so it has to survive a domain
        /// reload for the same reason the listing does. Without it a recompile brought the
        /// list back but silently lost every version - the rows simply were not there, which
        /// looks like a tool that publishes one release rather than like missing data.
        /// </remarks>
        private static BackendRecords cachedVersionRecords;

        /// <summary>
        /// Tool ids this project has a receipt for, shared across window instances.
        /// </summary>
        /// <remarks>
        /// Used to disable Uninstall for a tool that is not installed. Asking the
        /// backend with `status` keeps this derived from the receipts rather than
        /// guessed from the project layout.
        /// </remarks>
        private static readonly HashSet<string> installedIds = new HashSet<string>();

        /// <summary>
        /// The version each installed tool was installed at, from its receipt.
        /// </summary>
        /// <remarks>
        /// "Installed" alone cannot answer the question a user actually has: whether what is
        /// on disk is the release they are looking at. Keeping the version lets the window
        /// distinguish "installed" from "installed, but older than the one selected".
        /// </remarks>
        private static readonly Dictionary<string, string> installedVersions =
        new Dictionary<string, string>(StringComparer.Ordinal);

        private List<AvailableTool> tools
        {
            get { return cachedTools ?? (cachedTools = new List<AvailableTool>()); }
        }

        private Vector2 listScroll;
        private Vector2 detailScroll;

        /// <summary>
        /// Currently selected tool id.
        /// </summary>
        /// <remarks>
        /// Deliberately NOT a plain field. A domain reload (script recompile, entering
        /// play mode) destroys every window instance AND all static state, so the
        /// selection was lost and the details pane went blank until the user clicked the
        /// row again -- after every recompile, which during development is constantly.
        ///
        /// SessionState survives a domain reload and is scoped to the editor session, so
        /// it is the right lifetime: the selection should outlive a recompile but not the
        /// editor itself.
        /// </remarks>
        private string selectedId
        {
            get { return SessionState.GetString(SELECTED_ID_KEY, string.Empty); }
            set { SessionState.SetString(SELECTED_ID_KEY, value ?? string.Empty); }
        }

        // Session-scoped keys carry no prefix. They are not a public interface: renaming one
        // costs at most the current session's view state, which is why the vendor prefix was
        // dropped here while it is deliberately KEPT on the registry URL and the sibling
        // directory name - those two name something real outside this assembly, and changing
        // them would break the default remote and the sibling-checkout probe.
        private const string SELECTED_ID_KEY = "ToolImport.SelectedId";

        /// <summary>
        /// The release to install, as "id@version", or empty for the registry's latest.
        /// </summary>
        /// <remarks>
        /// Stored with its tool id rather than as a bare version, because a pin belongs to
        /// the tool it was chosen for. A bare version would silently apply to the next tool
        /// selected, and "0.9.0" means nothing for a tool that never published one.
        ///
        /// In SessionState for the same reason as the selection: a domain reload must not
        /// quietly move the user from the version they chose back to latest, which would be
        /// a silent change to what a later Install does.
        ///
        /// Empty means latest, which is why an explicit choice of latest stores a pin too:
        /// "I chose 1.0.0" and "I have not chosen" should not read differently if the
        /// registry later gains a newer release.
        /// </remarks>
        private string selectedVersion
        {
            get { return SessionState.GetString(SELECTED_VERSION_KEY, string.Empty); }
            set { SessionState.SetString(SELECTED_VERSION_KEY, value ?? string.Empty); }
        }

        private const string SELECTED_VERSION_KEY = "ToolImport.SelectedVersion";

        private string registryLocator = string.Empty;
        private string statusMessage = "Press Refresh to list the registry.";
        private BackendRecords detailRecords;
        private BackendRecords planRecords;

        /// <summary>
        /// The listing's records, kept for its VERSIONS entries.
        /// </summary>
        /// <remarks>
        /// `list` reports every published version of every tool, so the details pane can
        /// show them without a second backend call per selected tool.
        /// </remarks>
        private BackendRecords versionRecords;

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

        private static class Styles
        {
            public static int BaseFontSize
            {
                get
                {
                    return s_baseFontSize;
                }
                set
                {
                    if (value <= 0)
                    {
                        Debug.LogError($"The new value of '{nameof(BaseFontSize)}' is invalid. (Should be greater than zero.)");
                        return;
                    }
                    s_baseFontSize = value;
                }
            }
            private static int s_baseFontSize = 12;

            public static IReadOnlyDictionary<string, GUIStyle> CachedStyles
            {
                get
                {
                    if (readOnlyCachedStyles == null)
                    {
                        readOnlyCachedStyles = new ReadOnlyDictionary<string, GUIStyle>(cachedStyles);
                    }
                    return readOnlyCachedStyles;
                }
            }
            private static readonly Dictionary<string, GUIStyle> cachedStyles = new Dictionary<string, GUIStyle>();
            private static IReadOnlyDictionary<string, GUIStyle> readOnlyCachedStyles;

            public static IReadOnlyDictionary<string, Texture2D> CachedTextures
            {
                get
                {
                    if (readOnlyCachedTextures == null)
                    {
                        readOnlyCachedTextures = new ReadOnlyDictionary<string, Texture2D>(cachedTextures);
                    }
                    return readOnlyCachedTextures;
                }
            }
            private static readonly Dictionary<string, Texture2D> cachedTextures = new Dictionary<string, Texture2D>();
            private static IReadOnlyDictionary<string, Texture2D> readOnlyCachedTextures;

            /// <summary>Height of one list row. Tall enough to click comfortably.</summary>
            public const float TOOL_LIST_ITEM_HEIGHT = 20f;

            public static readonly Color SeparatorColor = new Color(0.5f, 0.5f, 0.5f, 0.35f);

            /// <summary>Fill behind the selected row.</summary>
            public static readonly Color SelectionFill = new Color(0.24f, 0.37f, 0.55f, 1f);

            /// <summary>Text colour on the selection fill, chosen for contrast.</summary>
            public static readonly Color SelectedTextColor = new Color(1f, 1f, 1f, 1f);

            public static GUIStyle GetStyle(GUIStyle source, Action<GUIStyle> styleSetter = null)
            {
                GUIStyle style = new GUIStyle(source);
                if (styleSetter != null) styleSetter(style);
                return style;
            }

            public static GUIStyle GetStyle<TState>(GUIStyle source, TState state, Action<TState, GUIStyle> styleSetter = null)
            {
                GUIStyle style = new GUIStyle(source);
                if (styleSetter != null) styleSetter(state, style);
                return style;
            }

            public static void CacheStyle(string key, GUIStyle style)
            {
                cachedStyles.Add(key, style);
            }

            public static void CacheTexture(string key, Texture2D texture)
            {
                cachedTextures.Add(key, texture);
            }

            public static GUIStyle GetOrCacheStyle(string key, Func<GUIStyle> styleCreator)
            {
                if (!cachedStyles.TryGetValue(key, out var style))
                {
                    style = styleCreator();
                    CacheStyle(key, style);
                }
                return style;
            }

            public static GUIStyle GetOrCacheStyle<TState>(string key, TState state, Func<TState, GUIStyle> styleCreator)
            {
                if (!cachedStyles.TryGetValue(key, out var style))
                {
                    style = styleCreator(state);
                    CacheStyle(key, style);
                }
                return style;
            }

            public static Texture2D GetOrCacheTexture(string key, Func<Texture2D> textureCreator)
            {
                if (!cachedTextures.TryGetValue(key, out var tex))
                {
                    tex = textureCreator();
                    CacheTexture(key, tex);
                }
                return tex;
            }

            public static Texture2D GetOrCacheTexture<TState>(string key, TState state, Func<TState, Texture2D> textureCreator)
            {
                if (!cachedTextures.TryGetValue(key, out var tex))
                {
                    tex = textureCreator(state);
                    CacheTexture(key, tex);
                }
                return tex;
            }

            public static void ClearCachedStyle()
            {
                cachedStyles.Clear();
            }

            public static void ClearCachedTexture(bool destroy = true)
            {
                if (!destroy) cachedTextures.Clear();
                else
                {
                    foreach (var tex in cachedTextures.Values)
                    {
                        DestroyImmediate(tex);
                    }
                }
            }
        }

        /// <summary>
        /// Named subsets, chosen instead of a set of independent toggles.
        /// </summary>
        /// <remarks>
        /// Independent toggles ("installed" and "not installed" both on) have states that
        /// mean nothing, and the user has to work out which combination they are in. One
        /// choice from a list cannot be contradictory.
        ///
        /// The last four each take a VALUE, chosen in a second dropdown. They exist because
        /// the listing already carries tags, capabilities and dependency edges, and there
        /// was no way to ask the questions they answer: "what is tagged editor", "what
        /// provides this capability", "what would break if I removed this". The backend can
        /// answer those over the whole registry with `list --provides`, but a front end
        /// holding the listing should not need a round trip to filter it.
        /// </remarks>
        private enum ToolFilter
        {
            All,
            Installed,
            NotInstalled,
            ThisEngine,
            Tag,
            Provides,
            Injects,
            DependsOn,
        }

        /// <summary>Search box contents are reset when the user clears it.</summary>
        private const string SEARCH_CONTROL_NAME = "ImportToolWindowSearch";

        /// <summary>Cached filtered list, rebuilt only when its inputs change.</summary>
        private List<AvailableTool> filteredTools;
        private string filterKey;
        private ToolFilter filterInstalledOnly;
        private int filterSourceCount = -1;

        /// <summary>The tag, capability or tool id a value-taking filter matches on.</summary>
        private string filterValue = string.Empty;

        /// <summary>
        /// The value a value-taking filter was last rebuilt against.
        /// </summary>
        /// <remarks>
        /// Part of the rebuild key. Without it, changing only the value (editor -> workflow)
        /// would leave the same cached list on screen, because the mode did not change.
        /// </remarks>
        private string filterValueKey;

        /// <summary>
        /// One command waiting for the in-flight one to finish.
        /// </summary>
        /// <remarks>
        /// Single-slot on purpose. A queue would let a burst of clicks pile up commands
        /// that are stale by the time they run; keeping only the newest is both simpler
        /// and closer to what the user meant.
        /// </remarks>
        private Action queuedCommand;

        private string EngineName = "unity";
        private Vector2 dependencyScrollPos;
        private Vector2 dependencyDetailViewScrollPos;
        private string selectedDependencyId;
        private readonly List<string> facts = new List<string>();
        private readonly StringBuilder stringBuilder = new StringBuilder();

        /// <summary>
        /// Directories the user chose for individual tools, keyed by tool id.
        /// </summary>
        /// <remarks>
        /// In memory only, and deliberately: a destination is a choice made for the next install,
        /// not project state. Persisting it would let a stale folder - typed once, forgotten,
        /// then applied to a reinstall months later - silently place a tool somewhere nobody
        /// expected. Every install states its destination in the confirmation the user reads.
        /// </remarks>
        private readonly Dictionary<string, string> installDirectories = new Dictionary<string, string>();

        private static readonly string[] filterLabels =
        {
            "All", "Installed", "Not installed", "This engine",
            "Tag is", "Provides", "Injects", "Depends on",
        };

        private static readonly ToolFilter[] filterValues =
        {
            ToolFilter.All, ToolFilter.Installed, ToolFilter.NotInstalled, ToolFilter.ThisEngine,
            ToolFilter.Tag, ToolFilter.Provides, ToolFilter.Injects, ToolFilter.DependsOn,
        };

        /// <summary>Width of the narrow rail left behind when the list is collapsed.</summary>
        private const float COLLAPSED_RAIL_WIDTH = 20f;

        /// <summary>
        /// Whether the tool list is hidden, leaving the details pane the full width.
        /// </summary>
        /// <remarks>
        /// For a tool with many capabilities, dependencies and files, the details pane is
        /// where the reading happens and the list is just a way back. SessionState so the
        /// choice survives a recompile, which is the same reason the selection is kept there:
        /// a domain reload should not rearrange the window under the user.
        /// </remarks>
        private bool listCollapsed
        {
            get { return SessionState.GetBool(LIST_COLLAPSED_KEY, false); }
            set { SessionState.SetBool(LIST_COLLAPSED_KEY, value); }
        }

        private const string LIST_COLLAPSED_KEY = "ToolImport.ListCollapsed";

        /// <summary>
        /// Directory names a registry checkout may have.
        /// </summary>
        /// <remarks>
        /// Mirrors <c>REGISTRY_DIR_NAMES</c> in the backend CLI. The two must agree, which is
        /// the cost of the probe living on both sides of the process boundary.
        /// </remarks>
        private static readonly string[] RegistryDirectoryNames =
        {
            "ToolRegistry",
            "DevCatToolRegistry",
        };

        [MenuItem("Window/ToolRegistry/Import Tool", priority = 1200)]
        private static void Open()
        {
            var window = GetWindow<ImportToolWindow>();
            window.titleContent = new GUIContent(nameof(ImportToolWindow));
            window.minSize = new Vector2(660f, 380f);
            window.Show();
        }

        private void OnEnable()
        {
            registryLocator = ResolveRegistryLocator();
            if (cachedTools != null && cachedTools.Count > 0)
            {
                statusMessage = "Ready.";
                // Restored together with the listing: the version rows are drawn from it, and
                // the two must never come from different runs.
                versionRecords = cachedVersionRecords;
                RefreshInstalled(RestoreSelection);
            }
            else
            {
                statusMessage = "Loading the registry...";
                RefreshInstalled(Refresh);
            }
        }

        private void OnDisable()
        {
            Styles.ClearCachedStyle();
            Styles.ClearCachedTexture(true);
        }

        /// <summary>
        /// Re-fetch the details for a selection that survived a reload.
        /// </summary>
        /// <remarks>
        /// The id outlives the reload but `detailRecords` does not, so the pane would be
        /// empty even though a row shows as selected. Re-running `show` is what makes the
        /// restored selection real rather than just a highlight.
        ///
        /// Runs whether or not the listing was cached: the records always need refetching,
        /// and the cached listing cannot supply them.
        /// </remarks>
        private void RestoreSelection()
        {
            string id = selectedId;
            if (!string.IsNullOrEmpty(id))
            {
                Select(id);
            }
        }

        /// <summary>
        /// The id argument for backend calls, carrying the pin when there is one.
        /// </summary>
        /// <remarks>
        /// One place builds this, so `show`, `plan` and `install` cannot disagree about
        /// which release is being described and which is being written.
        /// </remarks>
        private string SelectedReference()
        {
            if (string.IsNullOrEmpty(selectedId)) return string.Empty;
            string pin = selectedVersion;
            if (string.IsNullOrEmpty(pin)) return selectedId;
            return pin.StartsWith(selectedId + "@", StringComparison.Ordinal) ? pin : selectedId;
        }

        /// <summary>The version the pin names, or empty when following latest.</summary>
        private string PinnedVersion()
        {
            string pin = selectedVersion;
            if (string.IsNullOrEmpty(pin)) return string.Empty;
            int at = pin.IndexOf('@');
            if (at <= 0 || !pin.StartsWith(selectedId + "@", StringComparison.Ordinal)) return string.Empty;
            return pin.Substring(at + 1);
        }

        /// <summary>
        /// Re-read which tools this project has installed.
        /// </summary>
        private void RefreshInstalled(Action then = null)
        {
            Run("status", records =>
            {
                installedIds.Clear();
                installedVersions.Clear();
                foreach (string[] fields in records.Of("RECEIPT"))
                {
                    if (fields.Length == 0) continue;
                    installedIds.Add(fields[0]);
                    if (fields.Length > 1) installedVersions[fields[0]] = fields[1];
                }
                filteredTools = null;
                QueueCommand(then);
            });
        }

        private void OnGUI()
        {
            RebuildVisibleTools();

            DrawToolbar();

            if (tools.Count == 0)
            {
                EditorGUILayout.HelpBox(statusMessage, MessageType.Info);
                return;
            }

            EditorGUILayout.BeginHorizontal();
            if (listCollapsed) DrawCollapsedRail();
            else DrawToolList();
            DrawDetails();
            EditorGUILayout.EndHorizontal();

            Rect separator = EditorGUILayout.GetControlRect(false, 1f);
            EditorGUI.DrawRect(separator, Styles.SeparatorColor);

            EditorGUILayout.BeginHorizontal();
            var statusMessageStyle = Styles.GetOrCacheStyle(nameof(statusMessage), () => Styles.GetStyle(EditorStyles.miniLabel));
            EditorGUILayout.LabelField(statusMessage, statusMessageStyle);
            if (busy) GUILayout.Label("working...", EditorStyles.miniLabel, GUILayout.Width(80f));
            EditorGUILayout.EndHorizontal();
        }

        /// <summary>Width of the left column, clamped so neither side becomes unusable.</summary>
        private static float GetToolListWidth(Rect position)
        {
            float width = Mathf.Clamp(position.width * 0.38f, 200f, 420f);
            return width;
        }

        /// <summary>
        /// How much horizontal room the list column is actually taking.
        /// </summary>
        /// <remarks>
        /// Used by everything that measures text against the remaining width. Reading
        /// GetToolListWidth directly would keep wrapping the description as though the column
        /// were still there after it was collapsed, leaving a band of unexplained empty space
        /// down the right-hand side.
        /// </remarks>
        private float ToolListWidth()
        {
            return listCollapsed ? COLLAPSED_RAIL_WIDTH : GetToolListWidth(position);
        }

        /// <summary>
        /// The strip left when the list is collapsed, holding only the button that brings it
        /// back.
        /// </summary>
        /// <remarks>
        /// It stays on the LEFT, where the list was, so the control that reverses an action
        /// sits where the action happened. A button in the toolbar would also work and would
        /// be harder to find.
        /// </remarks>
        private void DrawCollapsedRail()
        {
            EditorGUILayout.BeginVertical(GUILayout.Width(COLLAPSED_RAIL_WIDTH));
            if (GUILayout.Button("\u203A", EditorStyles.miniButton, GUILayout.Width(COLLAPSED_RAIL_WIDTH)))
            {
                listCollapsed = false;
            }
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndVertical();
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
                && filterSourceCount == tools.Count
                && filterValueKey == filterValue)
            {
                return;
            }

            filterKey = searchText;
            filterInstalledOnly = filter;
            filterSourceCount = tools.Count;
            filterValueKey = filterValue;

            var visible = new List<AvailableTool>();
            foreach (AvailableTool tool in tools)
            {
                if (filter == ToolFilter.Installed && !installedIds.Contains(tool.Id)) continue;
                if (filter == ToolFilter.NotInstalled && installedIds.Contains(tool.Id)) continue;
                if (filter == ToolFilter.ThisEngine && !tool.Supports(EngineName)) continue;

                if (!MatchesValue(tool)) continue;
                if (!Matches(tool, searchText)) continue;
                visible.Add(tool);
            }
            filteredTools = visible;
            if (filteredTools.Count > 0 && !filteredTools.Exists(t => t.Id == selectedId))
            {
                selectedId = filteredTools[0].Id;
            }
            Select(selectedId);
        }

        /// <summary>
        /// Does a tool satisfy the current value-taking filter?
        /// </summary>
        /// <remarks>
        /// Modes without a value always pass, which keeps "All" from needing a special case
        /// here and keeps the list populated the moment a value mode is chosen.
        /// </remarks>
        private bool MatchesValue(AvailableTool tool)
        {
            if (string.IsNullOrEmpty(filterValue)) return true;

            switch (filter)
            {
                case ToolFilter.Tag:
                    return HasListValue(tool.Tags, filterValue);
                case ToolFilter.Provides:
                    return HasListValue(tool.Provides, filterValue);
                case ToolFilter.Injects:
                    return HasListValue(tool.Injects, filterValue);
                case ToolFilter.DependsOn:
                    return DependsOnTool(tool, filterValue);
                default:
                    return true;
            }
        }

        /// <summary>Does a comma-joined record field contain one value?</summary>
        /// <remarks>
        /// Exact match per element, not a substring: "editor" must not match
        /// "editor-tool", which a naive IndexOf would do and which reads as a wrong result.
        /// </remarks>
        internal static bool HasListValue(string commaSeparated, string needle)
        {
            if (string.IsNullOrEmpty(commaSeparated) || string.IsNullOrEmpty(needle)) return false;
            foreach (string raw in commaSeparated.Split(','))
            {
                if (string.Equals(raw.Trim(), needle, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// Does a tool depend on the given id?
        /// </summary>
        /// <remarks>
        /// TOOL carries dependencies as `id@constraint`, comma-joined, so the id has to be
        /// peeled off each entry before comparing. This is the reverse lookup that answers
        /// "what would break if I removed this", which is why the field is named for the
        /// question rather than for the field.
        /// </remarks>
        internal static bool DependsOnTool(AvailableTool tool, string id)
        {
            if (string.IsNullOrEmpty(tool.Dependencies) || string.IsNullOrEmpty(id)) return false;
            foreach (string raw in tool.Dependencies.Split(','))
            {
                string entry = raw.Trim();
                if (entry.Length == 0) continue;
                int at = entry.IndexOf('@');
                string dependencyId = at > 0 ? entry.Substring(0, at) : entry;
                if (string.Equals(dependencyId, id, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// Every tag, capability or id that the current filter mode can match on.
        /// </summary>
        /// <remarks>
        /// Collected from the listing rather than hard-coded, so the dropdown can only ever
        /// offer values that exist. A free-text box would let a typo silently produce an
        /// empty list, which is the failure the backend's `--provides` hint exists to avoid.
        /// </remarks>
        private List<string> FilterValueOptions()
        {
            var values = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (AvailableTool tool in tools)
            {
                string source;
                switch (filter)
                {
                    case ToolFilter.Tag: source = tool.Tags; break;
                    case ToolFilter.Provides: source = tool.Provides; break;
                    case ToolFilter.Injects: source = tool.Injects; break;
                    case ToolFilter.DependsOn: source = tool.Id; break;
                    default: return new List<string>();
                }

                foreach (string raw in (source ?? string.Empty).Split(','))
                {
                    string value = raw.Trim();
                    if (value.Length > 0) values.Add(value);
                }
            }
            return new List<string>(values);
        }

        /// <summary>Does the current filter mode need a value chosen?</summary>
        private bool FilterTakesValue()
        {
            return filter == ToolFilter.Tag
                || filter == ToolFilter.Provides
                || filter == ToolFilter.Injects
                || filter == ToolFilter.DependsOn;
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

            EditorGUILayout.LabelField(RegistryLabel());
            using (new EditorGUI.DisabledScope(busy))
            {
                if (GUILayout.Button("Refresh", EditorStyles.toolbarButton, GUILayout.Width(70f)))
                {
                    Refresh();
                }
            }
            if (GUILayout.Button("Settings", EditorStyles.toolbarButton, GUILayout.Width(74f)))
            {
                ImportToolSettingsWindow.Open();
            }

            GUILayout.FlexibleSpace();
            bool hadFocus = GUI.GetNameOfFocusedControl() == SEARCH_CONTROL_NAME;
            GUI.SetNextControlName(SEARCH_CONTROL_NAME);
            searchText = GUILayout.TextField(searchText ?? string.Empty, EditorStyles.toolbarSearchField, GUILayout.Width(200f));

            // Unity draws no text cursor for a toolbar field, so the pointer stayed an arrow
            // over the one control in the window that takes typing. AddCursorRect has to run
            // on every event to take effect, which is why it sits here rather than in a
            // repaint-only branch.
            EditorGUIUtility.AddCursorRect(GUILayoutUtility.GetLastRect(), MouseCursor.Text);

            if (hadFocus && Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Escape)
            {
                searchText = string.Empty;
                GUI.FocusControl(null);
                Event.current.Use();
            }

            EditorGUILayout.EndHorizontal();
        }

        /// <summary>
        /// A short, readable indication of the active registry.
        /// </summary>
        /// <remarks>
        /// The toolbar showed the FULL path in an editable field, which for a deep checkout
        /// pushed everything else off the row. This shows the leaf name and puts the full
        /// value in the tooltip, so the row stays readable and the detail is still one
        /// hover away.
        /// </remarks>
        private string RegistryLabel()
        {
            if (string.IsNullOrEmpty(registryLocator)) return "Registry: (none)";

            string leaf;
            if (registryLocator.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                if (Uri.TryCreate(registryLocator, UriKind.Absolute, out Uri uri)) leaf = uri.Host;
                else leaf = registryLocator;
            }
            else
            {
                leaf = Path.GetFileName(registryLocator.TrimEnd('/', '\\'));
                if (string.IsNullOrEmpty(leaf)) leaf = registryLocator;
            }

            return new GUIContent("Registry: " + leaf, registryLocator).text;
        }

        /// <summary>Re-read the registry location from the current settings.</summary>
        private void ReloadRegistryLocator()
        {
            registryLocator = ResolveRegistryLocator();
        }

        // ------------------------------------------------------------------
        // list
        // ------------------------------------------------------------------

        /// <summary>
        /// The left column: a filter row, then the tool list.
        /// </summary>
        /// <remarks>
        /// The FILTER lives here because it acts on this list and reads as a heading over
        /// it. The search box does not, and sits in the toolbar where one looks for it.
        /// </remarks>
        private void DrawToolList()
        {
            var width = GetToolListWidth(position);
            EditorGUILayout.BeginVertical(GUILayout.Width(width));

            using (new EditorGUILayout.HorizontalScope())
            {
                DrawListControls();
                if (GUILayout.Button("\u2039", EditorStyles.miniButton, GUILayout.Width(20f)))
                {
                    listCollapsed = true;
                }
            }

            Rect separator = EditorGUILayout.GetControlRect(false, 1f);
            EditorGUI.DrawRect(separator, Styles.SeparatorColor);

            listScroll = EditorGUILayout.BeginScrollView(listScroll, GUILayout.ExpandHeight(true));

            List<AvailableTool> visible = VisibleTools();
            if (visible.Count == 0)
            {
                EditorGUILayout.HelpBox(
                    tools.Count == 0
                        ? "The registry listed no tools."
                        : "No tool matches the current search or filter.",
                    MessageType.None);
            }

            foreach (AvailableTool tool in visible)
            {
                DrawToolListItem(tool);
            }

            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();

            DrawColumnSeparator();
        }

        /// <summary>
        /// A one-pixel vertical rule, drawn to the full height of the window.
        /// </summary>
        /// <remarks>
        /// Uses a zero-width rect and expands its height, because a horizontal scope
        /// gives no way to ask for "the rest of the vertical space" as a rectangle.
        /// </remarks>
        private void DrawColumnSeparator()
        {
            Rect rect = GUILayoutUtility.GetRect(1f, 1f, GUILayout.ExpandHeight(true));
            rect.width = 1f;
            EditorGUI.DrawRect(rect, Styles.SeparatorColor);
            GUILayout.Space(1f);
        }

        /// <summary>
        /// The filter row, laid out to the width of the list column.
        /// </summary>
        /// <remarks>
        /// Two rows when the mode takes a value: the mode, then the value. The second row is
        /// populated from the listing itself, so it can only offer values that exist.
        /// </remarks>
        private void DrawListControls()
        {
            int current = Array.IndexOf(filterValues, filter);
            int chosen = EditorGUILayout.Popup(current, filterLabels);
            if (chosen >= 0 && chosen < filterValues.Length && chosen != current)
            {
                filter = filterValues[chosen];
                filterValue = string.Empty;
            }

            if (!FilterTakesValue()) return;

            List<string> options = FilterValueOptions();
            if (options.Count == 0)
            {
                EditorGUILayout.LabelField("nothing to filter on", EditorStyles.miniLabel);
                return;
            }

            int index = options.FindIndex(v => string.Equals(v, filterValue, StringComparison.OrdinalIgnoreCase));
            if (index < 0) index = 0;

            int picked = EditorGUILayout.Popup(index, options.ToArray());
            if (picked >= 0 && picked < options.Count)
            {
                filterValue = options[picked];
            }
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
        private void DrawToolListItem(AvailableTool tool)
        {
            bool selected = tool.Id == selectedId;
            bool installed = installedIds.Contains(tool.Id);

            string marker = installed ? "● " : "○ ";
            string suffix = tool.Supports(EngineName) ? string.Empty : $"  [no {EngineName}]";

            var label = EditorGUIUtility.TrTextContent(tool.Id, $"{marker} {tool.DisplayName} {tool.Version} {suffix}", null, null);

            using (new EditorGUI.DisabledScope(busy))
            {
                var listItemStyle = Styles.GetOrCacheStyle("listItemStyle", () => Styles.GetStyle(EditorStyles.label, s =>
                {
                    s.alignment = TextAnchor.MiddleLeft;
                    s.padding = new RectOffset(0, 0, 2, 2);
                    s.fixedHeight = 0f;
                    s.wordWrap = false;
                    s.richText = false;
                    s.clipping = TextClipping.Clip;
                }));
                Rect row = GUILayoutUtility.GetRect(GUIContent.none, listItemStyle, GUILayout.ExpandWidth(true));
                row.height = Mathf.Max(Styles.TOOL_LIST_ITEM_HEIGHT, row.height);

                if (Event.current.type == EventType.Repaint)
                {
                    if (selected)
                    {
                        EditorGUI.DrawRect(row, Styles.SelectionFill);
                    }
                }

                var textRect = new Rect(row.x + 8f, row.y, Mathf.Max(0f, row.width - 12f), row.height);

                Color previous = GUI.color;
                GUI.color = selected ? Styles.SelectedTextColor : (installed ? EditorStyles.whiteLabel.normal.textColor : EditorStyles.label.normal.textColor);
                GUI.Label(textRect, label, listItemStyle);
                GUI.color = previous;

                if (Event.current.type == EventType.MouseDown
                    && Event.current.button == 0
                    && row.Contains(Event.current.mousePosition))
                {
                    Select(tool.Id);
                    Event.current.Use();
                }

                // Right-click selects the row and offers its versions. Selecting first is not
                // a side effect: a pin belongs to a tool, so the menu cannot offer the versions
                // of one row while a different row is selected.
                //
                // This is the ONLY version control. An inline list under the row was tried and
                // removed: it duplicated the menu, grew the list column unpredictably, and put
                // a per-release choice in a column that describes tools rather than releases.
                //
                // Both event shapes are accepted: Windows sends a right MouseDown and the
                // editor also synthesises ContextClick, while macOS delivers ContextClick
                // alone. Handling one of them makes the menu work on one platform only.
                bool contextClick = (Event.current.type == EventType.MouseDown && Event.current.button == 1)
                    || Event.current.type == EventType.ContextClick;
                if (contextClick && row.Contains(Event.current.mousePosition))
                {
                    Select(tool.Id);
                    ShowVersionMenu(tool.Id);
                    Event.current.Use();
                }
            }
        }

        /// <summary>
        /// The published versions of one tool, oldest last, with `latest` called out.
        /// </summary>
        /// <remarks>
        /// A static parse over the VERSIONS records rather than a method that reads the
        /// window's fields, so the record contract can be tested without an editor window.
        /// The shape is `VERSIONS &lt;id&gt; &lt;version&gt; [latest]`, one record per release.
        /// </remarks>
        internal static List<string> VersionsFrom(
            IEnumerable<string[]> records, string id, out string latest)
        {
            var versions = new List<string>();
            latest = string.Empty;
            if (records == null || string.IsNullOrEmpty(id)) return versions;

            foreach (string[] fields in records)
            {
                if (fields == null || fields.Length < 2) continue;
                if (!string.Equals(fields[0], id, StringComparison.Ordinal)) continue;
                versions.Add(fields[1]);
                if (fields.Length > 2 && fields[2] == "latest") latest = fields[1];
            }
            return versions;
        }

        private List<string> VersionsOf(string id, out string latest)
        {
            if (versionRecords == null)
            {
                latest = string.Empty;
                return new List<string>();
            }
            return VersionsFrom(versionRecords.Of("VERSIONS"), id, out latest);
        }

        /// <summary>
        /// The right-click menu for a row: one entry per release, checked against the pin.
        /// </summary>
        /// <remarks>
        /// The only way to choose a release, and the menu has to carry BOTH facts a chooser
        /// needs: which release is currently pinned (the check mark) and which one is actually
        /// installed (the suffix). "Installed" is not "selected": a user can browse 1.0.0 while
        /// 1.2.0 is what this project has, and an update is exactly the case where the two
        /// differ - the checked entry would otherwise look like the installed one.
        /// </remarks>
        private void ShowVersionMenu(string id)
        {
            string latest;
            List<string> versions = VersionsOf(id, out latest);
            string pinned = PinnedVersion();
            string installedVersion;
            installedVersions.TryGetValue(id, out installedVersion);

            var menu = new GenericMenu();
            if (versions.Count == 0)
            {
                menu.AddDisabledItem(new GUIContent("No versions listed"));
            }
            else
            {
                foreach (string version in versions)
                {
                    string chosen = version;
                    bool isLatest = version == latest;
                    bool isCurrent = pinned.Length > 0 ? pinned == version : isLatest;
                    bool isInstalled = !string.IsNullOrEmpty(installedVersion) && version == installedVersion;

                    menu.AddItem(
                        new GUIContent(
                            version
                            + (isLatest ? "  (latest)" : string.Empty)
                            + (isInstalled ? "  • installed" : string.Empty)),
                        isCurrent,
                        () => PinVersion(chosen));
                }
            }
            menu.ShowAsContext();
        }

        /// <summary>
        /// A label whose text can be selected and copied.
        /// </summary>
        /// <remarks>
        /// Used for every value a user might need OUTSIDE the editor: an id to paste into
        /// a command, a URL, a hash, a file path. Plain labels cannot be selected, which
        /// forced people to retype or transcribe by eye -- and a 64-character digest is
        /// not something to transcribe by eye.
        ///
        /// Word-wrapped labels keep their wrapping; the height is measured so the text is
        /// not clipped, which a SelectableLabel does not do on its own.
        /// </remarks>
        private void CopyableLabel(string text, bool wrap = true, GUIStyle style = null)
        {
            if (string.IsNullOrEmpty(text)) return;

            if (!wrap)
            {
                if (style == null) EditorGUILayout.SelectableLabel(text, GUILayout.Height(EditorGUIUtility.singleLineHeight));
                else EditorGUILayout.SelectableLabel(text, style, GUILayout.Height(EditorGUIUtility.singleLineHeight));
                return;
            }

            float width = position.width - ToolListWidth() - 100f;
            if (style == null)
            {
                var labelStyle = new GUIStyle(EditorStyles.label);
                labelStyle.wordWrap = true;
                float height = labelStyle.CalcHeight(new GUIContent(text), width);
                EditorGUILayout.SelectableLabel(text, labelStyle,
                GUILayout.Height(Mathf.Max(EditorGUIUtility.singleLineHeight, height)));
            }
            else
            {
                float height = style.CalcHeight(new GUIContent(text), width);
                EditorGUILayout.SelectableLabel(text, style,
                GUILayout.Height(Mathf.Max(EditorGUIUtility.singleLineHeight, height)));
            }
        }

        // ------------------------------------------------------------------
        // details
        // ------------------------------------------------------------------

        private void DrawDetails()
        {
            if (string.IsNullOrEmpty(selectedId) || detailRecords == null)
            {
                EditorGUILayout.HelpBox("Select a tool to review it before installing.", MessageType.None, true);
                GUILayout.FlexibleSpace();
                return;
            }

            EditorGUILayout.BeginVertical();

            detailScroll = EditorGUILayout.BeginScrollView(detailScroll, GUILayout.ExpandHeight(true));

            DrawDetailHeader();

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Description", EditorStyles.boldLabel);
            CopyableLabel(detailRecords.Detail("description"));

            // Four sections, each a header and its own list. The umbrella "Capabilities" header
            // was dropped with the chip row: with a header per section it added a fifth heading
            // that had no content of its own.
            EditorGUILayout.Space();
            DrawListSection("Engines", detailRecords.Detail("engines"));
            DrawListSection("Provides", detailRecords.Detail("provides"));
            DrawListSection("Injects", detailRecords.Detail("injects"));
            DrawListSection("Tags", detailRecords.Detail("tags"));
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

                string otherEngines = OtherEngines(detailRecords);
                if (!string.IsNullOrEmpty(otherEngines))
                {
                    EditorGUILayout.LabelField(
                        $"Also ships a target for: {otherEngines} (not installable here - this window installs into {EngineName}).",
                        EditorStyles.wordWrappedMiniLabel);
                }
            }

            var dependencies = new List<string[]>();
            foreach (string[] dependency in detailRecords.Of("DEPENDENCY"))
            {
                if (dependency.Length >= 4) dependencies.Add(dependency);
            }
            if (dependencies.Count > 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Dependencies", EditorStyles.boldLabel);

                Rect sepRect = EditorGUILayout.GetControlRect(false, 1, GUILayout.ExpandWidth(true));
                EditorGUI.DrawRect(sepRect, Styles.SeparatorColor);

                // A height, because this block sits inside the details scroll view. There,
                // ExpandHeight(true) has no parent height to expand INTO: the scroll view's
                // content is unbounded, so the inner scroll views collapsed to their minimum
                // and the dependency list showed about one row. An explicit height that grows
                // with the list - clamped so a tool with twenty dependencies cannot push the
                // actions off screen - is what makes the area usable.
                float dependencyHeight = Mathf.Clamp(dependencies.Count * 22f + 12f, 96f, 220f);
                using (new EditorGUILayout.HorizontalScope(GUILayout.Height(dependencyHeight)))
                {
                    int index = 0, selectedIndex = -1;
                    using (var dependencyScrollView = new EditorGUILayout.ScrollViewScope(dependencyScrollPos, GUILayout.Width(150f), GUILayout.ExpandHeight(true)))
                    {
                        dependencyScrollPos = dependencyScrollView.scrollPosition;
                        foreach (string[] dependency in dependencies)
                        {
                            string id = dependency[0];
                            bool known = IsInRegistry(id);
                            bool selected = selectedDependencyId == id;
                            if (selected) selectedIndex = index;

                            using (new EditorGUI.DisabledGroupScope(!known))
                            {
                                if (IMGUIUtility.DrawClickableLabel(id, selected,
                                selected == false ? Styles.GetOrCacheStyle("UnselectedDependencyStyle",
                                () => Styles.GetStyle(EditorStyles.label, s => { s.SetPadding(5, 1, 1, 1); })) : Styles.GetOrCacheStyle("SelectedDependencyStyle",
                                () => Styles.GetStyle(EditorStyles.label, s =>
                                {
                                    s.SetPadding(5, 1, 1, 1).SetBorder(1, 1, 1, 1);
                                    var tex = Styles.GetOrCacheTexture("SelectedDependencyTexture", () =>
                                    {
                                        var t = new Texture2D(1, 1);
                                        t.SetPixel(0, 0, new Color(0.24f, 0.37f, 0.58f, 0.6f));
                                        t.filterMode = FilterMode.Point;
                                        t.wrapMode = TextureWrapMode.Clamp;
                                        t.Apply();
                                        t.hideFlags = HideFlags.HideAndDontSave;
                                        return t;
                                    });

                                    s.onNormal.textColor = Color.white;
                                    s.onNormal.background = tex;

                                    s.onHover.textColor = Color.white;
                                    s.onHover.background = tex;

                                    s.onActive.textColor = Color.white;
                                    s.onActive.background = tex;
                                }))))
                                {
                                    dependencyDetailViewScrollPos = Vector2.zero;
                                    selectedDependencyId = id;
                                    selectedIndex = index;
                                    selected = true;
                                }
                            }

                            if (index++ < dependencies.Count - 1)
                            {
                                sepRect = EditorGUILayout.GetControlRect(false, 1, GUILayout.ExpandWidth(true));
                                EditorGUI.DrawRect(sepRect, Styles.SeparatorColor);
                            }
                        }
                    }

                    IMGUIUtility.VerticalSeparator();

                    var selectedDependency = selectedIndex >= 0 ? dependencies[selectedIndex] : null;
                    using (var dependencyDetailScrollView = new EditorGUILayout.ScrollViewScope(dependencyDetailViewScrollPos, GUILayout.ExpandHeight(true)))
                    {
                        dependencyDetailViewScrollPos = dependencyDetailScrollView.scrollPosition;
                        if (selectedDependency != null)
                        {
                            using (new EditorGUILayout.VerticalScope())
                            {
                                GUILayout.Label($"{HumanConstraint(selectedDependency[1])} ({selectedDependency[2]} ) {(IsInRegistry(selectedDependency[0]) ? string.Empty : "  - not in this registry")} \n {selectedDependency[3]}",
                                EditorStyles.miniLabel);
                                GUILayout.FlexibleSpace();
                                if (EditorGUILayout.LinkButton("Goto"))
                                {
                                    Select(selectedDependencyId);
                                    Repaint();
                                }
                            }
                        }
                        else
                        {
                            EditorGUILayout.HelpBox("You can select a dependency from left list.", MessageType.None);
                            GUILayout.FlexibleSpace();
                        }
                    }
                }
                sepRect = EditorGUILayout.GetControlRect(false, 1, GUILayout.ExpandWidth(true));
                EditorGUI.DrawRect(sepRect, Styles.SeparatorColor);
            }

            // Only this engine's inventory: a cross-engine tool's other payload never lands in
            // this project, and listing it here would read as "these files are about to be
            // written". The engine is filtered by the reader, which also keeps an unqualified
            // (engine-less) declaration visible.
            List<string> files = detailRecords.WillInstall(EngineName);
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

            EditorGUILayout.Space();

            bool installable = IsInstallableHere();
            if (!installable)
            {
                string reason = UninstallableReason();
                EditorGUILayout.HelpBox("Cannot install this tool.\n\n" + reason, MessageType.Warning);
            }

            DrawInstallDirectory(installable);

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

            using (new EditorGUI.DisabledScope(busy || !installedIds.Contains(selectedId) || string.IsNullOrEmpty(selectedId)))
            {
                if (GUILayout.Button(installedIds.Contains(selectedId) ? "Uninstall..." : "Uninstall (not installed)"))
                {
                    Uninstall();
                }
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.EndVertical();
        }

        /// <summary>
        /// Where the selected tool is installed, and the override for it.
        /// </summary>
        /// <remarks>
        /// The manifest declares the directory, which is right for most tools and wrong for
        /// anyone whose project is laid out differently - a tool that must live under
        /// Assets/Plugins, or one installed into a shared vendor folder. The value here is
        /// passed to the backend as `--into`, and the backend records the directory in the
        /// receipt, so uninstall finds the files afterwards without being told again.
        ///
        /// Empty means "as the manifest declares", and the label shows what that is, because a
        /// blank field with no hint is indistinguishable from a field the window failed to read.
        /// The exact directory of an unpacked tool is only known once its artifact is inspected
        /// (the manifest names the container's root, not the tool's), so the plan below is where
        /// the resolved paths appear.
        /// </remarks>
        private void DrawInstallDirectory(bool installable)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField("Install into", GUILayout.Width(96f));

                string overrideDirectory = InstallDirectoryFor(selectedId);
                string typed;
                using (new EditorGUI.DisabledScope(busy || !installable))
                {
                    typed = EditorGUILayout.TextField(
                        overrideDirectory, EditorStyles.textField, GUILayout.ExpandWidth(true));
                }
                if (typed != overrideDirectory)
                {
                    SetInstallDirectory(selectedId, typed);
                }

                using (new EditorGUI.DisabledScope(busy || !installable || overrideDirectory.Length == 0))
                {
                    if (GUILayout.Button("Default", EditorStyles.miniButton, GUILayout.Width(58f)))
                    {
                        SetInstallDirectory(selectedId, string.Empty);
                    }
                }
            }

            if (!installable) return;

            ToolTargetInfo mine = FindMyTarget();
            string declared = mine == null || string.IsNullOrEmpty(mine.ContentRoot)
                ? string.Empty
                : mine.ContentRoot;

            EditorGUILayout.LabelField(
                InstallDirectoryFor(selectedId).Length > 0
                    ? "A project-relative folder. The tool keeps its own subfolder inside it."
                    : declared.Length > 0
                        ? "Default: under " + declared + ", as the manifest declares. Type a folder to place it elsewhere."
                        : "Type a project-relative folder to choose where it goes.",
                EditorStyles.wordWrappedMiniLabel);
        }

        /// <summary>The directory the user chose for a tool, or empty when they chose none.</summary>
        private string InstallDirectoryFor(string id)
        {
            if (string.IsNullOrEmpty(id)) return string.Empty;
            string directory;
            return installDirectories.TryGetValue(id, out directory) ? directory : string.Empty;
        }

        private void SetInstallDirectory(string id, string directory)
        {
            if (string.IsNullOrEmpty(id)) return;
            string trimmed = (directory ?? string.Empty).Trim();
            if (trimmed.Length == 0) installDirectories.Remove(id);
            else installDirectories[id] = trimmed;

            // A plan describes one destination. Keeping the old one on screen beside a new
            // destination would be the same disagreement the plan/write separation exists to avoid.
            planRecords = null;
        }

        /// <summary>The `--into` argument for the selected tool, or empty.</summary>
        private string IntoArgument()
        {
            string directory = InstallDirectoryFor(selectedId);
            if (directory.Length == 0) return string.Empty;
            return " --into \"" + directory + "\"";
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
        /// The identity block at the top of the details pane.
        /// </summary>
        /// <remarks>
        /// Comma-joined fields are rendered as CHIPS, one per value, on wrapped rows.
        /// A single line such as
        /// `provides: script.api.argument-guards,script.api.object-pooling` is a wall of
        /// near-identical tokens that is hard to scan and easy to misread; discrete chips
        /// make the number of items visible at a glance. This is the same reason the Unity
        /// Package Manager shows capabilities as tags rather than as a string.
        /// </remarks>
        private void DrawDetailHeader()
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                var detailTitleStyle = Styles.GetOrCacheStyle("displayName", () => Styles.GetStyle(EditorStyles.boldLabel, s =>
                {
                    s.fontSize = 13;
                    s.contentOffset = new Vector2(s.contentOffset.x, IMGUIUtility.GetFontVerticalOffset(13, Styles.BaseFontSize));
                }));
                EditorGUILayout.LabelField(detailRecords.Detail("displayName"), detailTitleStyle);
                GUILayout.FlexibleSpace();
                if (installedIds.Contains(selectedId))
                {
                    var installedBadgeStyle = Styles.GetOrCacheStyle("installed", () => Styles.GetStyle(EditorStyles.miniLabel, s =>
                    {
                        s.padding = new RectOffset(6, 6, 2, 2);
                        s.alignment = TextAnchor.MiddleCenter;
                        s.normal.background = EditorStyles.toolbarButton.normal.background;
                    }));

                    string installedVersion;
                    installedVersions.TryGetValue(selectedId, out installedVersion);
                    GUILayout.Label(
                        string.IsNullOrEmpty(installedVersion)
                            ? "installed"
                            : "installed " + installedVersion,
                        installedBadgeStyle);
                }
            }

            CopyableLabel(detailRecords.Detail("id"));

            string version = detailRecords.Detail("version");
            string type = detailRecords.Detail("type");
            string license = detailRecords.Detail("license");
            string author = detailRecords.Detail("author");
            string homepage = detailRecords.Detail("homepage");
            string deprecated = detailRecords.Detail("deprecated");

            // Resolved BEFORE the facts line: whether the licence belongs there depends on
            // whether it ends up as a link, and computing it twice let the two disagree.
            string licenseUrl = LicenseUrl(license, detailRecords.Detail("licenseUrl"));

            facts.Clear();
            if (!string.IsNullOrEmpty(version)) facts.Add(version);
            if (!string.IsNullOrEmpty(type)) facts.Add(type);
            // A licence with no linkable destination stays inline; otherwise it moves to the link
            // row below, because "MIT" is a link to what MIT means, not a bare word.
            if (!string.IsNullOrEmpty(license) && licenseUrl.Length == 0) facts.Add(license);
            if (!string.IsNullOrEmpty(author)) facts.Add("by " + author);
            string releasedAt = detailRecords.Detail("releasedAt");
            if (!string.IsNullOrEmpty(releasedAt)) facts.Add("released " + releasedAt);
            if (deprecated == "true") facts.Add("DEPRECATED");
            if (detailRecords.Detail("yanked") == "true") facts.Add("YANKED");
            if (facts.Count > 0)
            {
                int count = facts.Count;
                for (int i = 0; i < count; i++)
                {
                    stringBuilder.Append(facts[i]);
                    if (i < count - 1) stringBuilder.Append("  •  ");
                }
                EditorGUILayout.LabelField(stringBuilder.ToString(), EditorStyles.miniLabel);
                facts.Clear();
                stringBuilder.Clear();
            }

            // "Installed" alone cannot say "installed, and behind". The menu marks the installed
            // release, but two numbers in two places is exactly what a reader should not have to
            // compare; this states it once, where the tool is described - and names the gesture,
            // because a right-click menu is invisible until somebody knows it is there.
            string installedAt;
            installedVersions.TryGetValue(selectedId, out installedAt);
            string latestPublished;
            List<string> publishedVersions = VersionsOf(selectedId, out latestPublished);
            if (!string.IsNullOrEmpty(installedAt) && !string.IsNullOrEmpty(latestPublished)
                && installedAt != latestPublished)
            {
                EditorGUILayout.LabelField(
                    "Installed " + installedAt + ", latest is " + latestPublished +
                    ". Right-click this tool in the list to choose " + latestPublished + ".",
                    EditorStyles.wordWrappedMiniLabel);
            }
            else if (publishedVersions.Count > 1)
            {
                EditorGUILayout.LabelField(
                    publishedVersions.Count + " versions published. Right-click this tool in the list to choose one.",
                    EditorStyles.wordWrappedMiniLabel);
            }

            // Links, as clickable labels rather than plain text: a URL that cannot be
            // clicked is a URL the user has to select and paste by hand, which is the
            // thing clickable text exists to avoid.
            //
            // Each is a SEPARATE destination and appears only when declared, so a tool that
            // declares none shows no dead controls. Release notes are a link and not a panel:
            // they belong to the maintainer's site, which can publish them per release and
            // correct them afterwards. Copying that text into the window meant a stale copy
            // inside a tool whose whole job is version precision.
            string documentation = detailRecords.Detail("documentation");
            string releaseNotes = detailRecords.Detail("releaseNotes");

            if (!string.IsNullOrEmpty(homepage) || !string.IsNullOrEmpty(documentation)
                || !string.IsNullOrEmpty(releaseNotes) || licenseUrl.Length > 0)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (!string.IsNullOrEmpty(homepage) && DrawLink("Homepage", homepage))
                    {
                        Application.OpenURL(homepage);
                    }
                    if (!string.IsNullOrEmpty(documentation) && DrawLink("Documentation", documentation))
                    {
                        Application.OpenURL(documentation);
                    }
                    if (!string.IsNullOrEmpty(releaseNotes) && DrawLink("Release notes", releaseNotes))
                    {
                        Application.OpenURL(releaseNotes);
                    }
                    // The licence name alone, with no "License:" prefix: in a row of four links
                    // a prefixed one reads as a labelled field, and "MIT" next to "Homepage"
                    // is not ambiguous - the tooltip says where it goes.
                    if (licenseUrl.Length > 0 && DrawLink(string.IsNullOrEmpty(license) ? "License" : license, licenseUrl))
                    {
                        Application.OpenURL(licenseUrl);
                    }
                    GUILayout.FlexibleSpace();
                }
            }
        }

        /// <summary>
        /// A link whose tooltip is the destination, with a link cursor over it.
        /// </summary>
        /// <remarks>
        /// The tooltip is the whole point: "Documentation" tells a user nothing about where
        /// they are about to go, and opening a URL to find out is the manual version of a
        /// hover. The text stays a label rather than the raw URL so several links fit on one
        /// row; the URL is one hover away.
        ///
        /// Drawn with a button in `linkLabel` style rather than `EditorGUILayout.LinkButton`,
        /// because that is exactly what LinkButton draws internally and this way the tooltip,
        /// the cursor and the click behaviour are set in one place for all four links.
        /// </remarks>
        private static bool DrawLink(string label, string url)
        {
            if (string.IsNullOrEmpty(url)) return false;

            var content = new GUIContent(label, url);
            GUIStyle style = EditorStyles.linkLabel;
            Rect rect = GUILayoutUtility.GetRect(content, style);
            EditorGUIUtility.AddCursorRect(rect, MouseCursor.Link);
            return GUI.Button(rect, content, style);
        }

        /// <summary>
        /// Where a licence id links to: the manifest's own URL when it declared one, otherwise
        /// the SPDX page for the identifier.
        /// </summary>
        /// <remarks>
        /// `license` is an SPDX identifier, not a URL - the schema says so and constrains it to
        /// `[A-Za-z0-9.-+]` - so spdx.org is where the value already points. `licenseUrl` exists
        /// for the case where it is not: a project that ships its own LICENSE file, or a
        /// proprietary licence with no SPDX entry. The declared value wins because a maintainer
        /// who names a destination means that destination.
        ///
        /// The identifier's shape is checked before deriving a URL. A hand-edited or third-party
        /// manifest can carry "see LICENSE", and percent-encoding that into a spdx.org URL would
        /// produce a dead link that looks authoritative, which is worse than the plain word it
        /// replaced.
        /// </remarks>
        internal static string LicenseUrl(string license, string declared = null)
        {
            if (!string.IsNullOrEmpty(declared)) return declared;
            if (string.IsNullOrEmpty(license)) return string.Empty;

            foreach (char c in license)
            {
                bool allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+';
                if (!allowed) return string.Empty;
            }
            return "https://spdx.org/licenses/" + license + ".html";
        }

        /// <summary>
        /// One capability section: a header, then one indented "- value" line per entry.
        /// </summary>
        /// <remarks>
        /// A list rather than a row of chips. Chips were tried and removed: a capability name is
        /// long ("script.api.argument-guards"), so a row of them wrapped mid-token at whatever
        /// width the pane happened to have, and two chips 2px apart read as one string. One
        /// entry per line cannot be misread, and a value is longer than the space between two
        /// of them is wide.
        ///
        /// Empty means "(none)" and is still shown. Silently omitting the section would leave
        /// the user unsure whether the tool declares nothing or the window failed to read it --
        /// and for `injects`, "nothing" is meaningful information.
        /// </remarks>
        private void DrawListSection(string header, string commaSeparated)
        {
            EditorGUILayout.LabelField(header, EditorStyles.boldLabel);

            var itemStyle = Styles.GetOrCacheStyle("listSectionItem", () => Styles.GetStyle(
                EditorStyles.miniLabel,
                s =>
                {
                    // Indented rather than padded with spaces: a space is the wrong width in
                    // every skin and font, and would not survive rich text or a font change.
                    s.padding = new RectOffset(16, 0, 0, 0);
                    s.wordWrap = true;
                }));

            var values = new List<string>();
            foreach (string raw in (commaSeparated ?? string.Empty).Split(','))
            {
                string value = raw.Trim();
                if (value.Length > 0) values.Add(value);
            }

            if (values.Count == 0)
            {
                EditorGUILayout.LabelField("- (none)", itemStyle);
                return;
            }

            foreach (string value in values)
            {
                EditorGUILayout.LabelField("- " + value, itemStyle);
            }
        }

        /// <summary>Is this tool id present in the loaded listing?</summary>
        /// <remarks>
        /// Used to decide whether a dependency can be jumped to. A tool may declare a
        /// dependency the registry does not carry, and offering a link that leads nowhere
        /// is worse than saying the id is absent.
        /// </remarks>
        private bool IsInRegistry(string id)
        {
            foreach (AvailableTool tool in tools)
            {
                if (tool.Id == id) return true;
            }
            return false;
        }

        /// <summary>
        /// Choose the release to install, and re-read its details.
        /// </summary>
        /// <remarks>
        /// The details are re-fetched because they are per-release: descriptions, floors and
        /// artifacts can all differ between versions, and showing latest's metadata beside a
        /// plan for an older release is worse than showing nothing.
        /// </remarks>
        private void PinVersion(string version)
        {
            if (string.IsNullOrEmpty(selectedId)) return;

            selectedVersion = selectedId + "@" + version;
            planRecords = null;
            Select(selectedId);
        }

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

                cachedTools = loaded;
                cachedRegistryLocator = registryLocator;
                versionRecords = records;
                cachedVersionRecords = records;
                statusMessage = "Ready.";
            });
        }

        /// <summary>
        /// Is this the command whose records the version list is read from?
        /// </summary>
        /// <remarks>
        /// `Run` receives the command as a single string, so the check is on its shape.
        /// Only `list` carries VERSIONS records; no other command can populate or
        /// invalidate them.
        /// </remarks>
        private static bool IsListingCommand(string arguments)
        {
            return arguments != null
                && (arguments == "list" || arguments.StartsWith("list ", StringComparison.Ordinal));
        }

        private void Select(string id)
        {
            GUIUtility.hotControl = 0;
            GUIUtility.keyboardControl = 0;
            dependencyScrollPos = Vector2.zero;
            selectedDependencyId = null;

            if (selectedId != id && !string.IsNullOrEmpty(selectedVersion))
            {
                string pin = selectedVersion;
                if (!pin.StartsWith(id + "@", StringComparison.Ordinal)) selectedVersion = string.Empty;
            }

            selectedId = id;
            planRecords = null;
            Run($"show \"{SelectedReference()}\"", records =>
            {
                detailRecords = records;
                statusMessage = "Review the requirements, then verify the plan.";
            });
        }

        private void Plan(bool dryRun)
        {
            if (string.IsNullOrEmpty(selectedId)) return;
            Run("plan \"" + SelectedReference() + "\"" + IntoArgument(), records =>
            {
                planRecords = records;
                List<string> problems = records.Problems();
                string pinned = PinnedVersion();
                statusMessage = problems.Count == 0
                    ? (pinned.Length > 0
                        ? "Plan verified for " + pinned + ". Nothing has been written yet."
                        : "Plan verified. Nothing has been written yet.")
                    : string.Format("Plan rejected: {0} problem(s). See the panel.", problems.Count);
            }, dryRun);
        }

        private void Install()
        {
            if (string.IsNullOrEmpty(selectedId)) return;
            string pinned = PinnedVersion();
            string target = pinned.Length > 0 ? selectedId + " " + pinned : selectedId;
            string directory = InstallDirectoryFor(selectedId);
            if (!EditorUtility.DisplayDialog(
                    "Install " + target + "?",
                    "The plan above was verified. Files will be written" +
                    (directory.Length > 0 ? " into " + directory : string.Empty) +
                    " and a receipt recorded so this can be uninstalled cleanly.",
                    "Install",
                    "Cancel"))
            {
                return;
            }

            Run("install \"" + SelectedReference() + "\"" + IntoArgument(), records =>
            {
                int installed = 0;
                foreach (string[] ignored in records.Of("INSTALLED"))
                {
                    installed++;
                }
                statusMessage = string.Format("{0} tool(s) installed. Receipts recorded under Library/.", installed);
                planRecords = null;
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

                // A receipt names paths. If the folder was moved after installing, every one of
                // those paths is gone: the uninstall then removes nothing, clears the receipt and
                // looks like it worked, while the files are still in the project. Saying so is the
                // only honest thing this window can do - it cannot delete a directory it has no
                // record of writing, and a moved folder looks exactly like a new one.
                string movedRoot = string.Empty;
                foreach (string[] entry in records.Of("MOVEDROOT"))
                {
                    if (entry.Length > 1 && entry[1].Length > 0) movedRoot = entry[1];
                }

                statusMessage = movedRoot.Length > 0
                    ? string.Format(
                        "Receipt for {0} cleared, but {1} is no longer there - it was moved or deleted " +
                        "outside this window, so nothing was removed. Remove that copy yourself.",
                        selectedId, movedRoot)
                    : string.Format("{0} file(s) removed for {1}.", removed, selectedId);

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
                command.Append(" --engine \"").Append(EngineName).Append('"');
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

                    // A failed `list` must not leave the PREVIOUS run's versions on
                    // screen describing a listing that was not loaded. The details pane
                    // would show a version list belonging to a different registry.
                    if (IsListingCommand(arguments)) versionRecords = null;
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
        /// Order: the settings window, then the UTOOL_REGISTRY environment variable, then a
        /// sibling checkout, then the published URL.
        ///
        /// The settings window comes FIRST because it is the one a user sets deliberately:
        /// an environment variable is usually inherited from a shell, and a silent
        /// override of an explicit choice would be baffling.
        ///
        /// The published URL is a best-effort LAST resort and does not currently resolve -
        /// the registry repository has nothing published beyond its initial commit, so a
        /// fetch against it returns 404. It is kept because it becomes correct the moment the
        /// registry is pushed, and because returning a URL produces a clearer failure (the
        /// backend says which URL and what to do) than returning an empty string would. It
        /// deliberately is NOT described as making a fresh clone work, because it does not.
        /// </remarks>
        private static string ResolveRegistryLocator()
        {
            string fromSettings = EditorPrefs.GetString(
                ImportToolSettingsWindow.REGISTRY_PREF_KEY, string.Empty);
            if (!string.IsNullOrEmpty(fromSettings))
            {
                // An override that no longer points anywhere must not win. The registry was
                // renamed once already, and every project that had saved the old path would
                // otherwise fail with "no index.yaml" while a perfectly good checkout sits
                // beside it. A URL is taken on trust - only a local path can be checked.
                if (IsUsableRegistryLocator(fromSettings))
                {
                    return fromSettings;
                }
            }

            return ResolveRegistryLocatorForDisplay();
        }

        /// <summary>
        /// Is a saved override still worth using?
        /// </summary>
        /// <remarks>
        /// A local path must still hold <c>payloads/</c>, which is the same test the automatic
        /// probe applies - so a stale path degrades to automatic resolution instead of to a
        /// confusing failure. Anything URL-shaped is accepted without a check: reaching it is
        /// the backend's problem, and a transient network failure is not a reason to silently
        /// ignore what the user configured.
        /// </remarks>
        internal static bool IsUsableRegistryLocator(string locator)
        {
            if (string.IsNullOrEmpty(locator)) return false;
            if (locator.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return true;
            return Directory.Exists(Path.Combine(locator, "payloads"));
        }

        /// <summary>
        /// The registry location the automatic rules produce, ignoring any override.
        /// </summary>
        /// <remarks>
        /// Separated so the settings window can show what "automatic" actually resolves to
        /// while an override is in force -- otherwise a user cannot tell whether clearing
        /// the field would find anything.
        /// </remarks>
        internal static string ResolveRegistryLocatorForDisplay()
        {
            string fromEnvironment = Environment.GetEnvironmentVariable(REGISTRY_PATH_VARIABLE);
            if (!string.IsNullOrEmpty(fromEnvironment))
            {
                return fromEnvironment;
            }

            var directory = new DirectoryInfo(Application.dataPath);
            for (int depth = 0; directory != null && depth < 6; depth++)
            {
                // Current name first, then the former one, so a checkout that has not been
                // renamed keeps resolving. Renaming a directory must not break the projects
                // that already point at it.
                foreach (string name in RegistryDirectoryNames)
                {
                    string candidate = Path.Combine(directory.FullName, name);
                    if (Directory.Exists(Path.Combine(candidate, "payloads")))
                    {
                        return candidate;
                    }
                }
                directory = directory.Parent;
            }

            return DEFAULT_REMOTE_REGISTRY;
        }

        /// <summary>
        /// Drop the cached listing, so the next open re-reads the registry.
        /// </summary>
        /// <remarks>
        /// Called when a setting changes. The cache is keyed on the tool count and the
        /// filter, not on the registry location, so without this a changed registry would
        /// keep showing the old tools until an explicit Refresh.
        /// </remarks>
        internal static void ForgetCachedListing()
        {
            cachedTools = null;
            cachedVersionRecords = null;
            cachedRegistryLocator = string.Empty;
            installedIds.Clear();
        }
    }
}
