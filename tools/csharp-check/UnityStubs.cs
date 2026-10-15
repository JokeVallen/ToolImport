// Minimal stand-ins for the Unity types the editor front end touches.
//
// Purpose: let `dotnet build` type-check the REAL front-end sources on a machine
// with no Unity installed, so a C# error surfaces in seconds instead of after an
// editor import. This file is never shipped and is not part of the tool.
//
// It only needs to cover what the sources actually use; every member here exists
// because a real call site needs it.

using System;
using System.Collections.Generic;

namespace UnityEngine
{
    public struct Vector2
    {
        public float x, y;
        public Vector2(float x, float y) { this.x = x; this.y = y; }
        public float width => x;
        public float height => y;

        /// <summary>Component access by index, as Unity allows: v[0] and v[1].</summary>
        public float this[int index]
        {
            get
            {
                if (index == 0) return x;
                if (index == 1) return y;
                throw new System.IndexOutOfRangeException($"Vector2 index {index} is out of range");
            }
            set
            {
                if (index == 0) { x = value; return; }
                if (index == 1) { y = value; return; }
                throw new System.IndexOutOfRangeException($"Vector2 index {index} is out of range");
            }
        }

        public static Vector2 operator -(Vector2 a, Vector2 b) => new Vector2(a.x - b.x, a.y - b.y);
        public static Vector2 zero => new Vector2(0f, 0f);
    }

    public struct Rect
    {
        public float x, y, width, height;
        public Rect(float x, float y, float width, float height)
        {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }

        public bool Contains(Vector2 point) =>
            point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
    }

    public class Object { }

    public class GUIContent
    {
        public GUIContent() { }
        public GUIContent(string text) { }
        public GUIContent(string text, string tooltip) { }
        public static GUIContent none = new GUIContent();
        public string text;
        public string tooltip;
    }

    public static class Debug
    {
        public static void LogException(Exception e) { }
        public static void Log(object o) { }
        public static void LogWarning(object o) { }
        public static void LogError(object o) { }
    }

    public static class Application
    {
        public static string dataPath => "/tmp/UnityProject/Assets";
        public static string unityVersion => "2021.3.5f1";
        public static void OpenURL(string url) { }
    }

    public enum MessageType { None, Info, Warning, Error }

    public enum TextClipping { Overflow, Clip, Ellipsis }

    /// <summary>Font weight and slant, as GUIStyle.fontStyle takes it.</summary>
    public enum FontStyle { Normal, Bold, Italic, BoldAndItalic }

    public enum TextAnchor { UpperLeft, UpperCenter, UpperRight, MiddleLeft, MiddleCenter, MiddleRight, LowerLeft, LowerCenter, LowerRight }

    public class RectOffset
    {
        public int left, right, top, bottom;

        public RectOffset() { }

        public RectOffset(int left, int right, int top, int bottom)
        {
            this.left = left;
            this.right = right;
            this.top = top;
            this.bottom = bottom;
        }

        public int horizontal => left + right;
        public int vertical => top + bottom;
    }

    public class GUIStyleState
    {
        public Color textColor;
        public Texture2D background;
    }

    public class Texture2D
    {
        public Texture2D() { }
        public Texture2D(int width, int height) { }
        public void SetPixel(int x, int y, Color color) { }
        public void Apply() { }
    }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b) { this.r = r; this.g = g; this.b = b; this.a = 1f; }
        public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; }
    }

    public static class Mathf
    {
        public static float Clamp(float value, float min, float max) =>
            value < min ? min : (value > max ? max : value);
        public static float Max(float a, float b) => a > b ? a : b;
        public static float Min(float a, float b) => a < b ? a : b;
        /// <summary>
        /// Unity's approximate float comparison. Mirrors the real tolerance, because a
        /// stub that returned a plain equality would let a wrong epsilon pass here and
        /// fail in the editor.
        /// </summary>
        public static bool Approximately(float a, float b) =>
            System.Math.Abs(b - a) < System.Math.Max(1e-06f * System.Math.Max(System.Math.Abs(a), System.Math.Abs(b)), 1.1754944e-38f * 8f);
    }

    public class GUIStyle
    {
        public GUIStyle() { }
        public GUIStyle(GUIStyle other) { }
        public float CalcHeight(GUIContent c, float w) => 40f;
        public Vector2 CalcSize(GUIContent c) => new Vector2(60f, 16f);
        public TextAnchor alignment;
        public RectOffset padding = new RectOffset();
        public RectOffset margin = new RectOffset();
        public int fontSize;
        public float fixedHeight;
        public bool wordWrap;
        public bool richText;
        public TextClipping clipping;
        public FontStyle fontStyle;
        /// <summary>Pixel nudge applied when drawing the content.</summary>
        public Vector2 contentOffset;
        /// <summary>Height of one line of text in this style.</summary>
        public float lineHeight = 16f;
        public bool stretchHeight;
        public bool stretchWidth;
        public GUIStyleState normal = new GUIStyleState();
        public GUIStyleState hover = new GUIStyleState();
        public GUIStyleState active = new GUIStyleState();
        public GUIStyleState onNormal = new GUIStyleState();
        public GUIStyleState onHover = new GUIStyleState();
        public GUIStyleState onActive = new GUIStyleState();
    }
    public class GUILayoutOption { }

    public static class GUILayout
    {
        public static bool Button(string text, params GUILayoutOption[] options) => false;
        public static bool Button(string text, GUIStyle style, params GUILayoutOption[] options) => false;
        public static bool Toggle(bool value, GUIContent content, string style, params GUILayoutOption[] options) => value;
        public static bool Toggle(bool value, GUIContent content, GUIStyle style, params GUILayoutOption[] options) => value;
        public static bool Toggle(bool value, string text, GUIStyle style, params GUILayoutOption[] options) => value;
        public static bool Toggle(bool value, string text, string style, params GUILayoutOption[] options) => value;
        public static void Label(string text, params GUILayoutOption[] options) { }
        public static void Label(string text, GUIStyle style, params GUILayoutOption[] options) { }
        public static void Label(GUIContent content, GUIStyle style, params GUILayoutOption[] options) { }
        public static void Label(GUIContent content, params GUILayoutOption[] options) { }
        public static void SelectableLabel(string text, GUIStyle style, params GUILayoutOption[] options) { }
        public static void SelectableLabel(string text, params GUILayoutOption[] options) { }
        public static bool LinkButton(string text) => false;
        public static bool LinkButton(GUIContent content, GUIStyle style) => false;
        public static bool LinkButton(GUIContent content) => false;
        public static GUILayoutOption MinHeight(float h) => new GUILayoutOption();
        public static void Space() { }
        public struct HorizontalScope : System.IDisposable
        {
            public HorizontalScope(params GUILayoutOption[] options) { }
            public void Dispose() { }
        }
        public struct VerticalScope : System.IDisposable
        {
            public VerticalScope(params GUILayoutOption[] options) { }
            public void Dispose() { }
        }
        public static Rect GetControlRect(bool hasLabel, float height, params GUILayoutOption[] options) =>
            new Rect(0f, 0f, 100f, height);
        public static void DrawRect(Rect rect, Color color) { }
        public static void BeginHorizontal(params GUILayoutOption[] options) { }
        public static void BeginHorizontal(GUIStyle style, params GUILayoutOption[] options) { }
        public static void EndHorizontal() { }
        public static void BeginVertical(params GUILayoutOption[] options) { }
        public static void EndVertical() { }
        public static GUILayoutOption Width(float w) => new GUILayoutOption();
        public static GUILayoutOption Height(float h) => new GUILayoutOption();
        public static GUILayoutOption ExpandWidth(bool expand) => new GUILayoutOption();
        public static void Space(float pixels) { }
        public static GUILayoutOption ExpandHeight(bool e) => new GUILayoutOption();
        public static Vector2 BeginScrollView(Vector2 pos, params GUILayoutOption[] options) => pos;
        public static void EndScrollView() { }
        public static void FlexibleSpace() { }
        public static string TextField(string text, GUIStyle style, params GUILayoutOption[] options) => text;
        public static int Popup(int selected, string[] options, GUIStyle style, params GUILayoutOption[] o) => selected;
    }

    /// <summary>Stand-in for the editor's immediate-mode event stream.</summary>
    public class Event
    {
        public static Event current = new Event();
        public EventType type;
        public int button;
        public Vector2 mousePosition;
        public KeyCode keyCode;
        public void Use() { }
    }

    public enum EventType { MouseDown, MouseUp, KeyDown, KeyUp, Repaint, Layout }

    public enum KeyCode { None, Escape, Return, Tab }

    /// <summary>Keyboard focus, used to detect and clear the search field.</summary>
    public static class GUI
    {
        public static string GetNameOfFocusedControl() => string.Empty;
        public static void SetNextControlName(string name) { }
        public static void FocusControl(string name) { }
        public static Color color = new Color(1f, 1f, 1f, 1f);
        public static GUISkin skin = new GUISkin();
        public static void Label(Rect rect, GUIContent content, GUIStyle style) { }
    }

    /// <summary>Rect reservation, used to draw a full-height column rule.</summary>
    /// <summary>The active skin, for reaching built-in styles by name.</summary>
    public class GUISkin
    {
        public GUIStyle label = new GUIStyle();
        public GUIStyle GetStyle(string name) => new GUIStyle();
    }

    public static class GUILayoutUtility
    {
        public static Rect GetRect(float width, float height, params GUILayoutOption[] options) =>
            new Rect(0f, 0f, width, height);

        public static Rect GetRect(GUIContent content, GUIStyle style, params GUILayoutOption[] options) =>
            new Rect(0f, 0f, 200f, 20f);
    }

    public static class EditorStyles
    {
        public static GUIStyle boldLabel = new GUIStyle();
        public static GUIStyle miniLabel = new GUIStyle();
        public static GUIStyle wordWrappedLabel = new GUIStyle();
        public static GUIStyle wordWrappedMiniLabel = new GUIStyle();
        public static GUIStyle toolbar = new GUIStyle();
        public static GUIStyle toolbarButton = new GUIStyle();
        public static GUIStyle toolbarTextField = new GUIStyle();
        public static GUIStyle toolbarSearchField = new GUIStyle();
        public static GUIStyle toolbarPopup = new GUIStyle();
        public static GUIStyle textArea = new GUIStyle();
        public static GUIStyle label = new GUIStyle();
        public static GUIStyle miniBoldLabel = new GUIStyle();
    }
}

namespace UnityEditor
{
    using UnityEngine;

    public class EditorWindow : UnityEngine.Object
    {
        public GUIContent titleContent = new GUIContent();
        public Vector2 minSize;
        public Rect position;
        public static T GetWindow<T>() where T : EditorWindow, new() => new T();
        public void Show() { }
        public void Repaint() { }
        public void Close() { }
    }

    public static class EditorGUILayout
    {
        public static void HelpBox(string message, MessageType type) { }
        public static void HelpBox(string message, MessageType type, bool wide) { }
        public static void LabelField(string label, params GUILayoutOption[] options) { }
        public static void LabelField(string label, GUIStyle style, params GUILayoutOption[] options) { }
        public static string TextField(string text, GUIStyle style, params GUILayoutOption[] options) => text;
        public static string TextField(string text, params GUILayoutOption[] options) => text;
        public static int Popup(int selected, string[] options, GUIStyle style, params GUILayoutOption[] options2) => selected;
        public static int Popup(int selected, string[] options, params GUILayoutOption[] options2) => selected;
        public static void SelectableLabel(string text, GUIStyle style, params GUILayoutOption[] options) { }
        public static void SelectableLabel(string text, params GUILayoutOption[] options) { }
        public static bool LinkButton(string text) => false;
        public static bool LinkButton(GUIContent content, GUIStyle style) => false;
        public static bool LinkButton(GUIContent content) => false;
        public static GUILayoutOption MinHeight(float h) => new GUILayoutOption();
        public static void Space() { }
        public struct HorizontalScope : System.IDisposable
        {
            public HorizontalScope(params GUILayoutOption[] options) { }
            public void Dispose() { }
        }
        public struct VerticalScope : System.IDisposable
        {
            public VerticalScope(params GUILayoutOption[] options) { }
            public void Dispose() { }
        }
        public static Rect GetControlRect(bool hasLabel, float height, params GUILayoutOption[] options) =>
            new Rect(0f, 0f, 100f, height);
        public static void DrawRect(Rect rect, Color color) { }
        public static void BeginHorizontal(params GUILayoutOption[] options) { }
        public static void BeginHorizontal(GUIStyle style, params GUILayoutOption[] options) { }
        public static void EndHorizontal() { }
        public static void BeginVertical(params GUILayoutOption[] options) { }
        public static void BeginVertical(GUIStyle style, params GUILayoutOption[] options) { }
        public static void EndVertical() { }
        public static Vector2 BeginScrollView(Vector2 pos, params GUILayoutOption[] options) => pos;
        public static void EndScrollView() { }
    }

    public static class EditorUtility
    {
        public static bool DisplayDialog(string title, string message, string ok, string cancel) => false;
        public static string OpenFolderPanel(string title, string folder, string defaultName) => string.Empty;
        public static string OpenFilePanel(string title, string folder, string extension) => string.Empty;
    }

    public static class AssetDatabase
    {
        public static void Refresh() { }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class MenuItemAttribute : Attribute
    {
        public MenuItemAttribute(string path) { }
        public MenuItemAttribute(string path, bool validate) { }
        public int priority;
    }

    /// <summary>
    /// Editor-session-scoped storage that survives a domain reload.
    /// </summary>
    /// <remarks>
    /// Used by the window to remember the selected tool across a script recompile. The
    /// stub keeps it in memory, which is enough to compile and to exercise behaviour; the
    /// real one persists under the project's Library folder.
    /// </remarks>
    public static class SessionState
    {
        private static readonly Dictionary<string, string> Store = new Dictionary<string, string>();

        public static string GetString(string key, string defaultValue) =>
            Store.TryGetValue(key, out string value) ? value : defaultValue;

        public static void SetString(string key, string value) { Store[key] = value; }

        public static void EraseString(string key) { Store.Remove(key); }
    }

    /// <summary>
    /// Per-user, per-machine settings storage.
    /// </summary>
    /// <remarks>
    /// The window uses this for paths to a checkout, which belong to the machine rather
    /// than to the project. The stub keeps them in memory.
    /// </remarks>
    public static class EditorPrefs
    {
        private static readonly Dictionary<string, string> Store = new Dictionary<string, string>();

        public static string GetString(string key, string defaultValue) =>
            Store.TryGetValue(key, out string value) ? value : defaultValue;

        public static void SetString(string key, string value) { Store[key] = value; }

        public static void DeleteKey(string key) { Store.Remove(key); }

        public static bool HasKey(string key) => Store.ContainsKey(key);
    }

    /// <summary>Stand-in for EditorGUI.DisabledScope, used as `using (new ...)`.</summary>
    public static class EditorGUIUtility
    {
        public static float singleLineHeight = 18f;
        /// <summary>True on the dark skin. Drives the selection colours.</summary>
        public static bool isProSkin = true;
        public static GUIContent TrTempContent(string text) => new GUIContent(text);
        public static GUIContent TrTextContent(string text) => new GUIContent(text);
        public static GUIContent TrTextContent(string text, string tooltip) => new GUIContent(text, tooltip);
        public static GUIContent TrTextContent(string text, string tooltip, Texture2D icon) =>
            new GUIContent(text, tooltip);
        public static GUIContent TrTextContent(
            string text, string tooltip, Texture2D icon, string fallbackText) => new GUIContent(text, tooltip);
    }

    /// <summary>Global IMGUI control state, used to drop focus.</summary>
    public static class GUIUtility
    {
        public static int hotControl;
        public static int keyboardControl;
    }

    public static class EditorGUI
    {
        public struct DisabledScope : IDisposable
        {
            public DisabledScope(bool disabled) { }
            public void Dispose() { }
        }

        public static void DrawRect(Rect rect, Color color) { }
    }
}
