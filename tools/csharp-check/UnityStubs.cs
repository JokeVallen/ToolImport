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
    }

    public enum MessageType { None, Info, Warning, Error }

    public class GUIStyle { }
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
        public static void Space() { }
        public static void BeginHorizontal(params GUILayoutOption[] options) { }
        public static void BeginHorizontal(GUIStyle style, params GUILayoutOption[] options) { }
        public static void EndHorizontal() { }
        public static void BeginVertical(params GUILayoutOption[] options) { }
        public static void EndVertical() { }
        public static GUILayoutOption Width(float w) => new GUILayoutOption();
        public static GUILayoutOption ExpandHeight(bool e) => new GUILayoutOption();
        public static Vector2 BeginScrollView(Vector2 pos, params GUILayoutOption[] options) => pos;
        public static void EndScrollView() { }
        public static void FlexibleSpace() { }
        public static string TextField(string text, GUIStyle style, params GUILayoutOption[] options) => text;
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
        public static void Space() { }
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

    /// <summary>Stand-in for EditorGUI.DisabledScope, used as `using (new ...)`.</summary>
    public static class EditorGUI
    {
        public struct DisabledScope : IDisposable
        {
            public DisabledScope(bool disabled) { }
            public void Dispose() { }
        }
    }
}
