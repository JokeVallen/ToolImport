// Behavioural checks for the record stream reader.
//
// WHY THIS EXISTS
// ---------------
// The type-check harness compiles the front end but never ran it, so a bug that
// type-checks perfectly could reach Unity. That happened: PLAN packs several
// key/value pairs into ONE record
//
//     PLAN  tools  2  bytes  2968  ok  true  dryRun  true
//
// and the reader looked for a record whose FIRST field was "ok". The first field
// is "tools", so the lookup always missed and fell back to false. A fully
// verified plan therefore reported "The plan could not be verified" in the
// editor -- while the plan printed underneath it, correctly, in full.
//
// Nothing here is Unity-specific: BackendRecords depends only on System.*, which
// is exactly why it can be executed on a machine with no Unity installed.

using System;
using System.Collections.Generic;
using ToolImport.Editor;

namespace CsharpCheck
{
    internal static class Program
    {
        private static int failures;

        private static void Check(string name, bool condition, string detail = "")
        {
            if (condition)
            {
                Console.WriteLine("  ok   " + name);
                return;
            }
            failures++;
            Console.WriteLine("  FAIL " + name + (detail.Length > 0 ? "  -> " + detail : string.Empty));
        }

        private static int Main()
        {
            Console.WriteLine("record reader behaviour");

            PlanOkIsRead();
            RecordVersionIsRead();
            ResultStillReadsPlainResultRecords();
            MissingKeyFallsBack();
            ProblemsAreCollected();
            DeclaredFilesAreFilteredByEngine();
            TheNewestWaitingCommandWins();
            TheFolderPanelPathIsMadeProjectRelative();
            PlanToolFieldsStayAligned();
            UnescapeHandlesTabAndNewline();
            SearchMatchesTheRightFields();
            ConstraintsArePutIntoWords();
            ToolTypeIsNotAVersion();
            VersionsCarryTheLatestMarker();
            LicenceLinksOnlyForIdentifiers();
            ListValuesMatchExactly();
            DependenciesAreMatchedByIdAlone();
            StaleRegistryOverridesAreIgnored();

            Console.WriteLine(failures == 0
                ? "record reader behaviour OK"
                : failures + " behavioural check(s) FAILED");
            return failures == 0 ? 0 : 1;
        }

        /// <summary>
        /// The regression. This is verbatim `utool plan --records` output.
        /// </summary>
        private static void PlanOkIsRead()
        {
            const string stream =
                "META\trecordsVersion\t2\n" +
                "META\tregistry\tD:\\\\reg\n" +
                "PLANTOOL\tcore-editor-utils\t1.1.0\tunity\tpackage\tunitypackage\t1709\te2ca\t\tfalse\tuser\t\n" +
                "PLANFILE\tcore-editor-utils\tAssets/Runtime/Core/Guard.cs\n" +
                "PLAN\ttools\t1\tbytes\t1709\tok\ttrue\tdryRun\ttrue\n";

            BackendRecords records = BackendRecords.Parse(stream);
            Check("a verified PLAN reports ok=true", records.ResultBool("ok"),
                "ResultBool(\"ok\") returned false for a plan that succeeded");
            Check("PLAN tools is readable", records.Result("tools") == "1", records.Result("tools"));
            Check("PLAN bytes is readable", records.Result("bytes") == "1709", records.Result("bytes"));
            Check("PLAN dryRun is readable", records.ResultBool("dryRun"), "dryRun not found");
        }

        private static void RecordVersionIsRead()
        {
            BackendRecords records = BackendRecords.Parse("META\trecordsVersion\t2\n");
            Check("recordsVersion is read", records.RecordsVersion() == "2", records.RecordsVersion());
        }

        /// <summary>
        /// RESULT key value must keep working; the fix must not break the old shape.
        /// </summary>
        private static void ResultStillReadsPlainResultRecords()
        {
            BackendRecords records = BackendRecords.Parse("RESULT\tinstalled\t2\tbytes\t2968\n");
            Check("RESULT pairs still read", records.Result("installed") == "2", records.Result("installed"));
            Check("RESULT middle pair reads", records.Result("bytes") == "2968", records.Result("bytes"));
        }

        private static void MissingKeyFallsBack()
        {
            BackendRecords records = BackendRecords.Parse("PLAN\ttools\t1\n");
            Check("an absent key returns the fallback", records.Result("nope", "fallback") == "fallback");
            Check("an absent bool falls back to false", !records.ResultBool("nope"));
            Check("an absent bool can fall back to true", records.ResultBool("nope", true));
        }

        private static void ProblemsAreCollected()
        {
            BackendRecords records = BackendRecords.Parse(
                "ERROR\tE-ARTIFACT-HASH\tartifact digest mismatch\n" +
                "PROBLEM\tE-PLATFORM-PARSE\thost version unparsable\n");

            List<string> problems = records.Problems();
            Check("both ERROR and PROBLEM are collected", problems.Count == 2, problems.Count.ToString());
            Check("a problem keeps its code", problems.Count > 0 && problems[0].StartsWith("E-ARTIFACT-HASH"),
                problems.Count > 0 ? problems[0] : "(none)");
        }

        /// <summary>
        /// WILLINSTALL carries the engine it belongs to, and the reader filters on it.
        /// </summary>
        /// <remarks>
        /// This is verbatim `utool show x --records` output. Before formatVersion 3 the inventory
        /// was a top-level list and the record had one field; reading that field alone was right
        /// then and wrong after the inventory moved onto (version, engine), where it produced an
        /// empty "Installs" section for every tool - a section that showed nothing rather than
        /// nothing existing.
        /// </remarks>
        private static void DeclaredFilesAreFilteredByEngine()
        {
            BackendRecords records = BackendRecords.Parse(
                "WILLINSTALL\tAssets/MyTool/MyTool.cs\tunity\n" +
                "WILLINSTALL\taddons/my_tool/plugin.cfg\tgodot\n" +
                "WILLINSTALL\tREADME.txt\t\n");

            List<string> unity = records.WillInstall("unity");
            Check("this engine's file is reported", unity.Contains("Assets/MyTool/MyTool.cs"),
                string.Join(",", unity));
            Check("another engine's file is not", !unity.Contains("addons/my_tool/plugin.cfg"),
                string.Join(",", unity));
            Check("an unqualified declaration is shown for any engine", unity.Contains("README.txt"),
                string.Join(",", unity));
            Check("the count is per engine, not the stream", unity.Count == 2, unity.Count.ToString());

            List<string> none = records.WillInstall(string.Empty);
            Check("no engine means no filtering", none.Count == 3, none.Count.ToString());
            Check("field 0 is still the file", none.Count > 0 && none[0] == "Assets/MyTool/MyTool.cs",
                none.Count > 0 ? none[0] : "(none)");
        }

        /// <summary>
        /// The single waiting slot keeps the NEWEST request, not the first.
        /// </summary>
        /// <remarks>
        /// The reported bug: choosing release 0.9.0 showed 1.0.0's details, and choosing 1.0.0
        /// showed 0.9.0's. Both halves came from this slot - the newest pin was recorded while
        /// the FIRST waiting request won the race to run, and a request that could not wait was
        /// dropped outright.
        /// </remarks>
        private static void TheNewestWaitingCommandWins()
        {
            var slot = new PendingCommand();
            Check("an empty slot has nothing to run", !slot.HasPending && slot.Take() == null);

            string ran = string.Empty;
            slot.Post(() => ran = "first");
            slot.Post(() => ran = "second");
            Check("the newest request is the one waiting", slot.HasPending);

            Action next = slot.Take();
            Check("taking empties the slot", !slot.HasPending && slot.Take() == null);
            Check("a command is returned", next != null);
            if (next != null) next();
            Check("the superseded request never runs", ran == "second", ran);

            slot.Post(null);
            Check("posting nothing leaves the slot empty", !slot.HasPending);
        }


        /// <summary>
        /// The folder panel returns an ABSOLUTE path; the backend only accepts a relative one.
        /// </summary>
        /// <remarks>
        /// The conversion is where a typo becomes an install in the wrong place, so it is done in
        /// one place and checked here: backslashes from the Windows panel, the project root itself
        /// (which means "no override", not the empty directory), and a sibling project whose name
        /// merely starts with this one's - the classic prefix bug that would accept it as inside.
        /// </remarks>
        private static void TheFolderPanelPathIsMadeProjectRelative()
        {
            const string root = @"C:\Projects\MyGame";

            string relative;
            Check("a folder inside the project becomes relative",
                ImportToolWindow.TryProjectRelative(root, @"C:\Projects\MyGame\Assets\Plugins", out relative)
                && relative == "Assets/Plugins", relative);

            Check("the other separator is accepted",
                ImportToolWindow.TryProjectRelative(root, "C:/Projects/MyGame/Assets/Vendor", out relative)
                && relative == "Assets/Vendor", relative);

            Check("case does not matter on Windows",
                ImportToolWindow.TryProjectRelative(root, @"c:\projects\mygame\Assets", out relative)
                && relative == "Assets", relative);

            Check("the project root itself means no override",
                ImportToolWindow.TryProjectRelative(root, @"C:\Projects\MyGame\", out relative)
                && relative == string.Empty, "[" + relative + "]");

            Check("a sibling project with a shared prefix is outside",
                !ImportToolWindow.TryProjectRelative(root, @"C:\Projects\MyGameOther\Assets", out relative));

            Check("an unrelated drive is outside",
                !ImportToolWindow.TryProjectRelative(root, @"D:\Projects\MyGame\Assets", out relative));
        }


        /// <summary>
        /// PLANTOOL is positional. If records.js ever reorders it, this fails here
        /// rather than showing the wrong column in the editor.
        /// </summary>
        private static void PlanToolFieldsStayAligned()
        {
            const string stream =
                "PLANTOOL\tcore-editor-utils\t1.1.0\tunity\tpackage\tunitypackage\t1709\tsha\t\tfalse\tuser\t\n";
            BackendRecords records = BackendRecords.Parse(stream);
            string[] fields = null;
            foreach (string[] candidate in records.Of("PLANTOOL"))
            {
                fields = candidate;
            }

            Check("PLANTOOL arrives", fields != null);
            if (fields == null) return;
            Check("field 0 is the id", fields.Length > 0 && fields[0] == "core-editor-utils");
            Check("field 1 is the version", fields.Length > 1 && fields[1] == "1.1.0");
            Check("field 2 is the engine", fields.Length > 2 && fields[2] == "unity");
            Check("field 5 is the size", fields.Length > 5 && fields[5] == "1709");
            Check("field 10 is skipped", fields.Length > 10 && fields[10] == string.Empty,
                fields.Length > 10 ? "[" + fields[10] + "]" : "(short)");
        }

        /// <summary>
        /// The tag/capability filter matches whole elements, not substrings.
        /// </summary>
        /// <remarks>
        /// A substring match would make the "editor" tag select every tool tagged
        /// "editor-tool" as well. The result would be defensible in the data and wrong on
        /// screen, which is the same failure shape as a search that matches an id the user
        /// cannot see.
        /// </remarks>
        private static void ListValuesMatchExactly()
        {
            Check("an exact element matches",
                ImportToolWindow.HasListValue("editor,workflow", "editor"));
            Check("a later element matches",
                ImportToolWindow.HasListValue("editor,workflow", "workflow"));
            Check("the match ignores case",
                ImportToolWindow.HasListValue("editor,workflow", "EDITOR"));
            Check("surrounding spaces are tolerated",
                ImportToolWindow.HasListValue("editor, workflow", "workflow"));
            Check("a prefix does NOT match",
                !ImportToolWindow.HasListValue("editor-tool", "editor"),
                "a substring match would select unrelated tools");
            Check("a suffix does NOT match",
                !ImportToolWindow.HasListValue("my-editor", "editor"));
            Check("an empty field matches nothing",
                !ImportToolWindow.HasListValue("", "editor"));
            Check("an empty needle matches nothing",
                !ImportToolWindow.HasListValue("editor", ""),
                "an empty filter must not be treated as a match by the value matcher");
        }

        /// <summary>
        /// "Depends on X" is answered from the tool's own dependency field.
        /// </summary>
        /// <remarks>
        /// TOOL carries dependencies as `id@constraint`, so the id has to be peeled off
        /// before comparing. Comparing the raw entry would never match anything, and the
        /// filter would look like it worked while always returning an empty list.
        /// </remarks>
        private static void DependenciesAreMatchedByIdAlone()
        {
            AvailableTool tool = AvailableTool.FromFields(new[]
            {
                "my-tool", "1.0.0", "editor-tool", "unity", "", "", "My Tool", "",
                "core-editor-utils@^1.1.0,libs-sharp-json", "payloads/my-tool/tool.yaml",
            });

            Check("a dependency with a constraint matches",
                ImportToolWindow.DependsOnTool(tool, "core-editor-utils"));
            Check("a dependency without a constraint matches",
                ImportToolWindow.DependsOnTool(tool, "libs-sharp-json"));
            Check("a tool it does not depend on does not match",
                !ImportToolWindow.DependsOnTool(tool, "editor-coroutines-lit"));
            Check("the constraint is not confused for the id",
                !ImportToolWindow.DependsOnTool(tool, "^1.1.0"));
            Check("a tool with no dependencies matches nothing",
                !ImportToolWindow.DependsOnTool(
                    AvailableTool.FromFields(new[] { "lonely", "1.0.0", "tool-library" }), "anything"));
        }

        /// <summary>
        /// A saved registry path that no longer exists must not be trusted.
        /// </summary>
        /// <remarks>
        /// The registry was renamed once already. Every project that had saved the old path
        /// would otherwise keep failing with "no index.yaml" while a perfectly good checkout sat
        /// beside it, and nothing on screen would say the saved path was the problem.
        /// </remarks>
        private static void StaleRegistryOverridesAreIgnored()
        {
            string root = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "utool-locator-" + Guid.NewGuid().ToString("N"));
            string real = System.IO.Path.Combine(root, "ToolRegistry");
            string bare = System.IO.Path.Combine(root, "not-a-registry");

            try
            {
                System.IO.Directory.CreateDirectory(System.IO.Path.Combine(real, "payloads"));
                System.IO.Directory.CreateDirectory(bare);

                Check("a checkout holding payloads is usable",
                    ImportToolWindow.IsUsableRegistryLocator(real));
                Check("a directory without payloads is not usable",
                    !ImportToolWindow.IsUsableRegistryLocator(bare),
                    "a template or stray directory must not be mistaken for a registry");
                Check("a path that does not exist is not usable",
                    !ImportToolWindow.IsUsableRegistryLocator(System.IO.Path.Combine(root, "gone")));

                // A URL cannot be checked without a request, and refusing it on an offline
                // machine would silently ignore what the user configured.
                Check("an https locator is taken on trust",
                    ImportToolWindow.IsUsableRegistryLocator("https://example.invalid/reg"));
                Check("an empty locator is not usable",
                    !ImportToolWindow.IsUsableRegistryLocator(string.Empty));
            }
            finally
            {
                try { System.IO.Directory.Delete(root, true); } catch { }
            }
        }

        private static void UnescapeHandlesTabAndNewline()
        {
            Check("escaped tab is restored", BackendRecords.Unescape("a\\tb") == "a\tb");
            Check("escaped newline is restored", BackendRecords.Unescape("a\\nb") == "a\nb");
            Check("escaped backslash is restored", BackendRecords.Unescape("a\\\\b") == "a\\b");
            Check("plain text is untouched", BackendRecords.Unescape("Assets/Guard.cs") == "Assets/Guard.cs");
        }

        /// <summary>
        /// The regression behind "the version list never appeared".
        ///
        /// The details pane read a version out of TOOL field 2, which is not a version at
        /// all -- it is `type`. The value therefore became the literal string
        /// "tool-library", and because it was then compared against "latest" it never
        /// matched, so no version was ever marked.
        ///
        /// This stream is verbatim `utool list --records` output.
        /// </summary>
        private static void ToolTypeIsNotAVersion()
        {
            BackendRecords records = BackendRecords.Parse(
                "TOOL\tlibs-sharp-json\t3.0.0\ttool-library\tunity\t" +
                "data.json.serialization\t\tSharpJson\tjson,assembly\t\tpayloads/libs-sharp-json/tool.yaml\n");

            AvailableTool tool = null;
            foreach (string[] fields in records.Of("TOOL"))
            {
                tool = AvailableTool.FromFields(fields);
            }

            Check("a TOOL record arrives", tool != null);
            if (tool == null) return;
            Check("field 1 is the version", tool.Version == "3.0.0", tool.Version);
            Check("field 2 is the type, NOT a version", tool.Type == "tool-library", tool.Type);
            Check("the version is not the type", tool.Version != tool.Type,
                "Version was read from the type field: " + tool.Version);
        }

        /// <summary>
        /// VERSIONS is the only place that says which version is latest.
        ///
        /// It carries one record per published version, tagged explicitly. Both the inline
        /// list under a selected row and the right-click menu are built from this parser, so
        /// a mistake here would show the wrong releases in two places at once - or, worse,
        /// mark two of them as latest.
        /// </summary>
        private static void VersionsCarryTheLatestMarker()
        {
            BackendRecords records = BackendRecords.Parse(
                "TOOL\teditor-tool-selection-history\t1.0.0\teditor-tool\tunity\t" +
                "unity.window.selection-history\tscript.api.argument-guards\tSelection History\t" +
                "editor,workflow\tcore-editor-utils@^1.1.0\tpayloads/editor-tool-selection-history/tool.yaml\n" +
                "VERSIONS\teditor-tool-selection-history\t1.0.0\tlatest\n" +
                "VERSIONS\teditor-tool-selection-history\t0.9.0\t\n" +
                "TOOL\tlibs-sharp-json\t3.0.0\ttool-library\tunity\t\t\tSharpJson\t\t\tpayloads/libs-sharp-json/tool.yaml\n" +
                "VERSIONS\tlibs-sharp-json\t3.0.0\tlatest\n");

            string latest;
            List<string> mine = ImportToolWindow.VersionsFrom(
                records.Of("VERSIONS"), "editor-tool-selection-history", out latest);

            Check("both published versions are seen", mine.Count == 2, mine.Count.ToString());
            Check("the older version is included", mine.Contains("0.9.0"), string.Join(",", mine.ToArray()));
            Check("exactly one version is marked latest", latest == "1.0.0", latest);

            // The filter is by id, so another tool's versions must not leak in. This is
            // also why comparing whole field arrays would match nothing: the values differ
            // per row even for the same tool.
            Check("another tool's versions are excluded", !mine.Contains("3.0.0"),
                string.Join(",", mine.ToArray()));

            // A tool with no versions reported must produce an empty list rather than throw:
            // `show` can finish before any `list` has, and OnGUI would then die every frame.
            string noLatest;
            Check("an unknown tool has no versions",
                ImportToolWindow.VersionsFrom(records.Of("VERSIONS"), "nope", out noLatest).Count == 0);
            Check("an unknown tool has no latest", noLatest == string.Empty, noLatest);
            Check("a missing stream has no versions",
                ImportToolWindow.VersionsFrom(null, "editor-tool-selection-history", out noLatest).Count == 0);
        }

        /// <summary>
        /// The licence link: the manifest's own URL when it declared one, otherwise the SPDX
        /// page for the identifier, and only when the value is shaped like one.
        ///
        /// `license` is an identifier, not a URL: the schema documents it as an SPDX id and
        /// constrains it to `[A-Za-z0-9.-+]`, so spdx.org is where the value already points.
        /// The shape check is for data that bypassed the schema ("see LICENSE"), where
        /// percent-encoding into a spdx.org URL would produce a dead link that looks
        /// authoritative.
        /// </summary>
        private static void LicenceLinksOnlyForIdentifiers()
        {
            Check("MIT links to its SPDX page",
                ImportToolWindow.LicenseUrl("MIT") == "https://spdx.org/licenses/MIT.html",
                ImportToolWindow.LicenseUrl("MIT"));
            Check("a dotted id keeps its punctuation",
                ImportToolWindow.LicenseUrl("Apache-2.0") == "https://spdx.org/licenses/Apache-2.0.html",
                ImportToolWindow.LicenseUrl("Apache-2.0"));
            Check("a plus-suffixed id is an id",
                ImportToolWindow.LicenseUrl("GPL-2.0+").EndsWith("/GPL-2.0+.html", StringComparison.Ordinal),
                ImportToolWindow.LicenseUrl("GPL-2.0+"));
            Check("spaces are not linked", ImportToolWindow.LicenseUrl("see LICENSE") == string.Empty,
                ImportToolWindow.LicenseUrl("see LICENSE"));
            Check("a path is not linked", ImportToolWindow.LicenseUrl("../LICENSE") == string.Empty,
                ImportToolWindow.LicenseUrl("../LICENSE"));
            Check("an empty licence is not linked", ImportToolWindow.LicenseUrl("") == string.Empty);
            Check("a null licence is not linked", ImportToolWindow.LicenseUrl(null) == string.Empty);
            // A manifest may name its own licence destination, which is why `licenseUrl` exists:
            // not every licence has an SPDX page, and a project that ships its own LICENSE file
            // means that file. A declared destination beats the derived one.
            Check(
                "a declared licence URL wins over the identifier's page",
                ImportToolWindow.LicenseUrl("MIT", "https://example.invalid/LICENSE.txt")
                    == "https://example.invalid/LICENSE.txt",
                ImportToolWindow.LicenseUrl("MIT", "https://example.invalid/LICENSE.txt"));
            Check(
                "a declared URL is used even with no identifier",
                ImportToolWindow.LicenseUrl("", "https://example.invalid/LICENSE")
                    == "https://example.invalid/LICENSE",
                ImportToolWindow.LicenseUrl("", "https://example.invalid/LICENSE"));
        }

        /// <summary>
        /// Search is the window's only real logic. A filter that silently matches
        /// nothing looks exactly like an empty registry, so it is tested directly.
        /// </summary>
        private static void SearchMatchesTheRightFields()
        {
            // Built from a TOOL record, so this also pins the field order.
            AvailableTool tool = AvailableTool.FromFields(new[]
            {
                "libs-sharp-json", "3.0.0", "tool-library", "unity",
                "data.json.serialization", "", "SharpJson", "json,assembly", "", "payloads/x/tool.yaml",
            });

            Check("an empty needle matches", ImportToolWindow.Matches(tool, ""));
            Check("a null needle matches", ImportToolWindow.Matches(tool, null));
            Check("the display name matches", ImportToolWindow.Matches(tool, "SharpJson"));

            // Substring, not prefix: someone hunting the JSON library types "json".
            Check("a substring matches anywhere", ImportToolWindow.Matches(tool, "json"));
            Check("case is ignored", ImportToolWindow.Matches(tool, "SHARPJSON"));
            Check("a non-match does not match", !ImportToolWindow.Matches(tool, "godot"));

            // REGRESSION: the display name is the ONLY field searched. Searching the id
            // made "s" return this tool, and it looked like a bug because the id -- the
            // thing that actually matched -- is not shown anywhere in the list.
            Check("the id is NOT searched", !ImportToolWindow.Matches(tool, "libs-sharp-json"));
            Check("tags are NOT searched by the text box", !ImportToolWindow.Matches(tool, "assembly"));
            Check("provides is NOT searched by the text box", !ImportToolWindow.Matches(tool, "serialization"));
        }

        /// <summary>
        /// Version constraints are written for the resolver, so the UI must translate
        /// them. `^1.1.0` in a details pane tells a user nothing.
        /// </summary>
        private static void ConstraintsArePutIntoWords()
        {
            Check("caret", ImportToolWindow.HumanConstraint("^1.1.0") == "1.1.0 or newer (same major)");
            Check("tilde", ImportToolWindow.HumanConstraint("~2.0.3") == "2.0.3 or newer (same major.minor)");
            Check("gte", ImportToolWindow.HumanConstraint(">=1.2.0") == "1.2.0 or newer");
            Check("lt", ImportToolWindow.HumanConstraint("<2.0.0") == "older than 2.0.0");
            Check("exact", ImportToolWindow.HumanConstraint("1.4.2") == "exactly 1.4.2");
            Check("empty means any", ImportToolWindow.HumanConstraint("") == "any version");
            Check("null means any", ImportToolWindow.HumanConstraint(null) == "any version");
        }
    }
}
