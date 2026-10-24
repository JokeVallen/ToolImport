namespace ToolImport.Editor
{
    /// <summary>
    /// The version of the import tool itself, in one place.
    /// </summary>
    /// <remarks>
    /// A constant rather than a runtime lookup: the Unity front end ships as loose editor
    /// scripts and has no package metadata to read once they are copied into a project. The
    /// Godot addon reads the same value from its own plugin.cfg, so both front ends can show
    /// the release they came from, and `tools/make-release.mjs` refuses to build when this
    /// constant and package.json disagree - which is the only thing that kept it honest while
    /// this was a hand-edited number.
    /// </remarks>
    internal static class ToolImportVersion
    {
        public const string Value = "1.2.2";
    }
}
