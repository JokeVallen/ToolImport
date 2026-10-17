using UnityEngine;

namespace ToolImport.Editor
{
    internal static partial class Extensions
    {
        public static GUIStyle SetAlignment(this GUIStyle style, TextAnchor alignment)
        {
            style.alignment = alignment;
            return style;
        }

        public static GUIStyle SetPadding(this GUIStyle style, int? left, int? right, int? top, int? bottom)
        {
            var padding = style.padding;
            if (left.HasValue) padding.left = left.Value;
            if (right.HasValue) padding.right = right.Value;
            if (top.HasValue) padding.top = top.Value;
            if (bottom.HasValue) padding.bottom = bottom.Value;
            return style;
        }

        public static GUIStyle SetBorder(this GUIStyle style, int? left, int? right, int? top, int? bottom)
        {
            var border = style.border;
            if (left.HasValue) border.left = left.Value;
            if (right.HasValue) border.right = right.Value;
            if (top.HasValue) border.top = top.Value;
            if (bottom.HasValue) border.bottom = bottom.Value;
            return style;
        }

        public static GUIStyle SetMargin(this GUIStyle style, int? left, int? right, int? top, int? bottom)
        {
            var margin = style.margin;
            if (left.HasValue) margin.left = left.Value;
            if (right.HasValue) margin.right = right.Value;
            if (top.HasValue) margin.top = top.Value;
            if (bottom.HasValue) margin.bottom = bottom.Value;
            return style;
        }

        public static GUIStyle SetContentOffset(this GUIStyle style, float? x, float? y)
        {
            var contentOffset = style.contentOffset;
            if (x.HasValue) contentOffset[0] = x.Value;
            if (y.HasValue) contentOffset[1] = y.Value;
            style.contentOffset = contentOffset;
            return style;
        }
    }
}