using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DevCat.ToolImport.Editor
{
    /// <summary>
    /// Parses the backend's <c>--records</c> output.
    /// </summary>
    /// <remarks>
    /// The backend offers three output modes: prose for a terminal, JSON for
    /// scripts, and records for embedders. This window uses records on purpose.
    /// UnityEngine.JsonUtility cannot deserialise a root-level array, and
    /// hand-writing a JSON parser inside the editor would duplicate logic that
    /// belongs to the backend. A record stream reduces the editor's job to a
    /// split on TAB, which is small enough to be obviously correct.
    ///
    /// Record grammar: TYPE \t field \t field ... \n, where a field escapes
    /// backslash, TAB, CR and LF. Types are documented in <c>utool --help</c>.
    /// </remarks>
    internal sealed class BackendRecords
    {
        /// <summary>Record type and its fields, in order.</summary>
        public readonly List<KeyValuePair<string, string[]>> All = new List<KeyValuePair<string, string[]>>();

        /// <summary>Value of a two-field record such as RESULT key value.</summary>
        public string Result(string key, string fallback = "")
        {
            foreach (var entry in All)
            {
                if (entry.Key == "RESULT" && entry.Value.Length >= 2 && entry.Value[0] == key)
                {
                    return entry.Value[1];
                }
            }
            return fallback;
        }

        public bool ResultBool(string key, bool fallback = false)
        {
            string value = Result(key, null);
            if (value == null) return fallback;
            return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Every record of one type, in arrival order.</summary>
        public IEnumerable<string[]> Of(string type)
        {
            foreach (var entry in All)
            {
                if (entry.Key == type)
                {
                    yield return entry.Value;
                }
            }
        }

        public bool Has(string type)
        {
            foreach (var entry in All)
            {
                if (entry.Key == type) return true;
            }
            return false;
        }

        /// <summary>The first field of a DETAIL record, or an empty string.</summary>
        public string Detail(string key)
        {
            foreach (var entry in All)
            {
                if (entry.Key == "DETAIL" && entry.Value.Length >= 2 && entry.Value[0] == key)
                {
                    return entry.Value[1];
                }
            }
            return string.Empty;
        }

        /// <summary>All values of a DETAIL record with the given key.</summary>
        public List<string> Details(string key)
        {
            var values = new List<string>();
            foreach (var entry in All)
            {
                if (entry.Key == "DETAIL" && entry.Value.Length >= 2 && entry.Value[0] == key)
                {
                    values.Add(entry.Value[1]);
                }
            }
            return values;
        }

        /// <summary>Human-readable problems, suitable for a help box.</summary>
        public List<string> Problems()
        {
            var problems = new List<string>();
            foreach (var entry in All)
            {
                if (entry.Key == "PROBLEM" && entry.Value.Length >= 2)
                {
                    problems.Add(entry.Value[0] + ": " + entry.Value[1]);
                }
                else if (entry.Key == "ERROR" && entry.Value.Length >= 2)
                {
                    problems.Add(entry.Value[0] + ": " + entry.Value[1]);
                }
            }
            return problems;
        }

        /// <summary>
        /// Parse a record stream. Unrecognised lines are ignored rather than
        /// throwing, so a future backend that adds a record type does not break
        /// an older window.
        /// </summary>
        public static BackendRecords Parse(string text)
        {
            var records = new BackendRecords();
            if (string.IsNullOrEmpty(text))
            {
                return records;
            }

            foreach (string rawLine in text.Split('\n'))
            {
                string line = rawLine.TrimEnd('\r');
                if (line.Length == 0)
                {
                    continue;
                }

                string[] parts = line.Split('\t');
                string type = parts[0];
                var fields = new string[parts.Length - 1];
                for (int i = 1; i < parts.Length; i++)
                {
                    fields[i - 1] = Unescape(parts[i]);
                }
                records.All.Add(new KeyValuePair<string, string[]>(type, fields));
            }

            return records;
        }

        /// <summary>Reverse of the backend's field escaping.</summary>
        internal static string Unescape(string field)
        {
            if (field.IndexOf('\\') < 0)
            {
                return field;
            }

            var builder = new StringBuilder(field.Length);
            for (int i = 0; i < field.Length; i++)
            {
                if (field[i] != '\\' || i + 1 >= field.Length)
                {
                    builder.Append(field[i]);
                    continue;
                }

                i++;
                switch (field[i])
                {
                    case 't': builder.Append('\t'); break;
                    case 'r': builder.Append('\r'); break;
                    case 'n': builder.Append('\n'); break;
                    case '\\': builder.Append('\\'); break;
                    default: builder.Append(field[i]); break;
                }
            }
            return builder.ToString();
        }
    }

    /// <summary>One row of <c>utool list --records</c>.</summary>
    /// <remarks>
    /// Field order must match <c>apps/cli/lib/records.js</c> toolSummaries(). It is
    /// engine-neutral: the engine-specific floors and artifacts arrive separately,
    /// one TARGET record per engine, because a cross-engine tool has several sets
    /// and flattening them would lose which belongs to which engine.
    /// </remarks>
    internal sealed class AvailableTool
    {
        public string Id = string.Empty;
        public string Version = string.Empty;
        public string Type = string.Empty;
        public string Engines = string.Empty;
        public string Provides = string.Empty;
        public string Injects = string.Empty;
        public string DisplayName = string.Empty;
        public string Tags = string.Empty;
        public string Dependencies = string.Empty;
        public string ManifestPath = string.Empty;

        /// <summary>Per-engine detail, filled from the matching TARGET records.</summary>
        public readonly List<ToolTargetInfo> Targets = new List<ToolTargetInfo>();

        public bool Supports(string engine)
        {
            foreach (string name in Engines.Split(','))
            {
                if (name.Trim() == engine) return true;
            }
            return false;
        }

        /// <summary>Field order matches records.js toolSummaries().</summary>
        public static AvailableTool FromFields(string[] fields)
        {
            var tool = new AvailableTool();
            if (fields.Length > 0) tool.Id = fields[0];
            if (fields.Length > 1) tool.Version = fields[1];
            if (fields.Length > 2) tool.Type = fields[2];
            if (fields.Length > 3) tool.Engines = fields[3];
            if (fields.Length > 4) tool.Provides = fields[4];
            if (fields.Length > 5) tool.Injects = fields[5];
            if (fields.Length > 6) tool.DisplayName = fields[6];
            if (fields.Length > 7) tool.Tags = fields[7];
            if (fields.Length > 8) tool.Dependencies = fields[8];
            if (fields.Length > 9) tool.ManifestPath = fields[9];
            return tool;
        }

        public override string ToString()
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} ({1}) - {2} [{3}]",
                string.IsNullOrEmpty(DisplayName) ? Id : DisplayName,
                Version,
                Type,
                Engines);
        }
    }

    /// <summary>One TARGET record: one engine's floors and artifact for a tool.</summary>
    /// <remarks>Field order matches records.js toolTargets().</remarks>
    internal sealed class ToolTargetInfo
    {
        public string Engine = string.Empty;
        public string MinEngineVersion = string.Empty;
        /// <summary>Adapter-defined floors beyond minEngineVersion, as "key=value,...".</summary>
        public string ExtraRequirements = string.Empty;
        public string ArtifactType = string.Empty;
        public string ArtifactFormat = string.Empty;
        public string ArtifactPath = string.Empty;
        public string ContentRoot = string.Empty;
        public string TargetPath = string.Empty;
        public bool EditorOnly;
        public string ExternalUrl = string.Empty;
        public string ExternalRef = string.Empty;

        public bool IsExternal => ArtifactType == "external";

        public static ToolTargetInfo FromFields(string[] fields)
        {
            var target = new ToolTargetInfo();
            if (fields.Length > 0) target.Engine = fields[0];
            if (fields.Length > 1) target.MinEngineVersion = fields[1];
            if (fields.Length > 2) target.ExtraRequirements = fields[2];
            if (fields.Length > 3) target.ArtifactType = fields[3];
            if (fields.Length > 4) target.ArtifactFormat = fields[4];
            if (fields.Length > 5) target.ArtifactPath = fields[5];
            if (fields.Length > 6) target.ContentRoot = fields[6];
            if (fields.Length > 7) target.TargetPath = fields[7];
            if (fields.Length > 8) target.EditorOnly = fields[8] == "true";
            if (fields.Length > 9) target.ExternalUrl = fields[9];
            if (fields.Length > 10) target.ExternalRef = fields[10];
            return target;
        }

        /// <summary>Human-readable requirement summary, adapter keys included.</summary>
        public string RequirementsSummary()
        {
            var text = new StringBuilder();
            if (!string.IsNullOrEmpty(MinEngineVersion))
            {
                text.Append("min engine ").Append(MinEngineVersion);
            }
            if (!string.IsNullOrEmpty(ExtraRequirements))
            {
                if (text.Length > 0) text.Append(", ");
                text.Append(ExtraRequirements.Replace(",", ", "));
            }
            return text.Length > 0 ? text.ToString() : "(none declared)";
        }
    }
}
