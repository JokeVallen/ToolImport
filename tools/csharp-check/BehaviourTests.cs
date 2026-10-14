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
using DevCat.ToolImport.Editor;

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
            PlanToolFieldsStayAligned();
            UnescapeHandlesTabAndNewline();
            SearchMatchesTheRightFields();

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

        private static void UnescapeHandlesTabAndNewline()
        {
            Check("escaped tab is restored", BackendRecords.Unescape("a\\tb") == "a\tb");
            Check("escaped newline is restored", BackendRecords.Unescape("a\\nb") == "a\nb");
            Check("escaped backslash is restored", BackendRecords.Unescape("a\\\\b") == "a\\b");
            Check("plain text is untouched", BackendRecords.Unescape("Assets/Guard.cs") == "Assets/Guard.cs");
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
            Check("id matches", ImportToolWindow.Matches(tool, "libs-sharp-json"));
            Check("display name matches", ImportToolWindow.Matches(tool, "SharpJson"));
            Check("type matches", ImportToolWindow.Matches(tool, "tool-library"));
            Check("tags match", ImportToolWindow.Matches(tool, "assembly"));
            Check("provides matches", ImportToolWindow.Matches(tool, "serialization"));

            // Substring, not prefix: someone hunting the JSON library types "json".
            Check("substring matches anywhere", ImportToolWindow.Matches(tool, "json"));
            Check("case is ignored", ImportToolWindow.Matches(tool, "SHARPJSON"));
            Check("a non-match does not match", !ImportToolWindow.Matches(tool, "godot"));
        }
    }
}
