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
        public static Vector2 operator -(Vector2 a, Vector2 b) => new Vector2(a.x - b.x, a.y - b.y);
    }

    public struct Rect
    {
        public float x, y, width, height;
        public Rect(float x, float y, float width, float height)
        {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
    }

    public class Object { }

    public class GUIContent
    {
        public GUIContent() { }
        public GUIContent(string text) { }
        public GUIContent(string text, string tooltip) { }
        public string text;
        public string tooltip;
    }

    public static class Debug
    {
        public static void LogException(Exception e) { }
        public static void Log(object o) { }
        public static void LogWarning(object o) { }
    }

    public static class Application
    {
        public static string dataPath => "/tmp/UnityProject/Assets";
        public static string unityVersion => "2021.3.5f1";
        public static void OpenURL(string url) { }
    }

    public enum MessageType { None, Info, Warning, Error }

    public enum TextAnchor { UpperLeft, UpperCenter, UpperRight, MiddleLeft, MiddleCenter, MiddleRight, LowerLeft, LowerCenter, LowerRight }

    public class RectOffset
    {
        public RectOffset() { }
        public RectOffset(int left, int right, int top, int bottom) { }
    }

    public class GUIStyleState
    {
        public Color textColor;
        public Texture2D background;
    }

    public class Texture2D { }

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
        public static void SelectableLabel(string text, GUIStyle style, params GUILayoutOption[] options) { }
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
    }

    public static class EditorGUILayout
    {
        public static void HelpBox(string message, MessageType type) { }
        public static void LabelField(string label, params GUILayoutOption[] options) { }
        public static void LabelField(string label, GUIStyle style, params GUILayoutOption[] options) { }
        public static string TextField(string text, GUIStyle style, params GUILayoutOption[] options) => text;
        public static int Popup(int selected, string[] options, GUIStyle style, params GUILayoutOption[] options2) => selected;
        public static int Popup(int selected, string[] options, params GUILayoutOption[] options2) => selected;
        public static void SelectableLabel(string text, GUIStyle style, params GUILayoutOption[] options) { }
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

    /// <summary>Standard control heights and spacing, as the editor reports them.</summary>
    public static class EditorGUIUtility
    {
        public static float singleLineHeight = 18f;
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
