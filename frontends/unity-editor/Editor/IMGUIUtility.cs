using UnityEditor;
using UnityEngine;

namespace ToolImport.Editor
{
    internal static class IMGUIUtility
    {
        public static float GetFontVerticalOffset(int fontSize, int baseFontSize = 12)
        {
            return (fontSize - baseFontSize) * 0.5f;
        }

        /// <summary>
        /// 基于基准样式派生出新样式，并统一垂直对齐相关的属性。
        /// </summary>
        /// <param name="baseStyle">基准样式，例如 EditorStyles.miniLabel</param>
        /// <param name="fontStyle">可选：覆盖字体样式（Bold/Italic 等）</param>
        /// <param name="fontSize">可选：覆盖字体大小，0 表示不修改</param>
        /// <param name="contentOffsetY">可选：垂直像素级微调</param>
        public static GUIStyle GetDeriveAlignedStyle(GUIStyle baseStyle, FontStyle? fontStyle = null, int? fontSize = null, float? contentOffsetY = null)
        {
            var style = new GUIStyle(baseStyle);

            // 1. 统一对齐锚点，保证文本在矩形内的基准位置一致
            style.alignment = TextAnchor.MiddleLeft;

            // 2. 清零内边距，避免不同样式的默认 padding 造成偏移
            style.padding = new RectOffset(0, 0, 0, 0);

            // 3. 应用调用方需要的覆盖项
            if (fontStyle.HasValue) style.fontStyle = fontStyle.Value;
            if (fontSize.HasValue) style.fontSize = fontSize.Value;

            // 4. 最后的像素级微调（一般不需要，仅在视觉确认有偏差时使用）
            if (contentOffsetY.HasValue) style.contentOffset = new Vector2(style.contentOffset.x, contentOffsetY.Value);

            return style;
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="text">显示文本</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(string text, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(EditorGUIUtility.TrTempContent(text), false, null, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="content">显示文本</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(GUIContent content, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(content, false, null, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="text">显示文本</param>
        /// <param name="isSelected">是否处于选中态</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(string text, bool isSelected, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(EditorGUIUtility.TrTempContent(text), isSelected, null, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="content">显示文本</param>
        /// <param name="isSelected">是否处于选中态</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(GUIContent content, bool isSelected, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(content, isSelected, null, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="text">显示文本</param>
        /// <param name="style">样式</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(string text, GUIStyle style, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(EditorGUIUtility.TrTempContent(text), false, style, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="content">显示文本</param>
        /// <param name="style">样式</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(GUIContent content, GUIStyle style, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(content, false, style, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="text">显示文本</param>
        /// <param name="isSelected">是否处于选中态</param>
        /// <param name="style">样式</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(string text, bool isSelected, GUIStyle style, params GUILayoutOption[] options)
        {
            return DrawClickableLabel(EditorGUIUtility.TrTempContent(text), isSelected, style, options);
        }

        /// <summary>
        /// 绘制一个可点击、可选中、可悬停高亮的 Label。
        /// 样式状态通过 GUIStyle 的 normal / hover / active 自动切换。
        /// </summary>
        /// <param name="content">显示文本</param>
        /// <param name="isSelected">是否处于选中态</param>
        /// <param name="style">样式</param>
        /// <param name="options">布局选项</param>
        /// <returns>是否被点击</returns>
        public static bool DrawClickableLabel(GUIContent content, bool isSelected, GUIStyle style, params GUILayoutOption[] options)
        {
            style ??= EditorStyles.label;

            // 1. 申请布局矩形
            Rect rect = GUILayoutUtility.GetRect(content, style, options);

            // 2. 判断鼠标状态
            int controlId = GUIUtility.GetControlID(FocusType.Passive, rect);
            bool isHover = rect.Contains(Event.current.mousePosition);

            // 3. 处理点击事件
            Event e = Event.current;
            switch (e.GetTypeForControl(controlId))
            {
                case EventType.MouseDown:
                    if (isHover && e.button == 0)
                    {
                        GUIUtility.hotControl = controlId;
                        e.Use();
                    }
                    break;
                case EventType.MouseUp:
                    if (GUIUtility.hotControl == controlId)
                    {
                        GUIUtility.hotControl = 0;
                        if (isHover && e.button == 0)
                        {
                            e.Use();
                            return true;
                        }
                    }
                    break;
                case EventType.Repaint:
                    bool isPressed = GUIUtility.hotControl == controlId && isHover;
                    var bg = isSelected ? style.onNormal.background
                        : isPressed ? style.onActive.background
                        : isHover ? style.onHover.background
                        : null;
                    if (bg != null) GUI.DrawTexture(rect, bg);
                    style.Draw(rect, content, isHover, isPressed, isSelected, false);
                    break;
            }

            return false;
        }

        /// <summary>
        /// 绘制一条水平分隔线，占满当前可用宽度。
        /// </summary>
        public static void HorizontalSeparator(float thickness = 1f, Color? color = null, float spacing = 4f)
        {
            GUILayout.Space(spacing);

            Rect rect = GUILayoutUtility.GetRect(
                GUIContent.none,
                GUIStyle.none,
                GUILayout.ExpandWidth(true),
                GUILayout.Height(thickness)
            );

            if (Event.current.type == EventType.Repaint)
                EditorGUI.DrawRect(rect, color ?? new Color(0.5f, 0.5f, 0.5f, 0.35f));

            GUILayout.Space(spacing);
        }

        /// <summary>
        /// 绘制一条垂直分隔线，占满当前可用高度。
        /// 必须在 HorizontalScope 内调用。
        /// </summary>
        public static void VerticalSeparator(float thickness = 1f, Color? color = null, float spacing = 4f)
        {
            GUILayout.Space(spacing);

            Rect rect = GUILayoutUtility.GetRect(
                thickness,
                thickness,
                GUILayout.ExpandHeight(true)
            );
            // 强制宽度，防止布局系统在水平方向挤压
            rect.width = thickness;

            if (Event.current.type == EventType.Repaint)
                EditorGUI.DrawRect(rect, color ?? new Color(0.5f, 0.5f, 0.5f, 0.35f));

            GUILayout.Space(spacing);
        }
    }
}