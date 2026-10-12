using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DevCat.UnityDevCommonLib.ImportTool.Editor
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
    internal sealed class AvailableTool
    {
        public string Id = string.Empty;
        public string Version = string.Empty;
        public string Type = string.Empty;
        public string SourceKind = string.Empty;
        public string MinUnityVersion = string.Empty;
        public string MinDotNetVersion = string.Empty;
        public string DisplayName = string.Empty;
        public string Tags = string.Empty;
        public string Dependencies = string.Empty;
        public string ArtifactPath = string.Empty;

        public bool IsExternal => SourceKind == "external";

        /// <summary>Field order matches records.js toolSummaries().</summary>
        public static AvailableTool FromFields(string[] fields)
        {
            var tool = new AvailableTool();
            if (fields.Length > 0) tool.Id = fields[0];
            if (fields.Length > 1) tool.Version = fields[1];
            if (fields.Length > 2) tool.Type = fields[2];
            if (fields.Length > 3) tool.SourceKind = fields[3];
            if (fields.Length > 4) tool.MinUnityVersion = fields[4];
            if (fields.Length > 5) tool.MinDotNetVersion = fields[5];
            if (fields.Length > 6) tool.DisplayName = fields[6];
            if (fields.Length > 7) tool.Tags = fields[7];
            if (fields.Length > 8) tool.Dependencies = fields[8];
            if (fields.Length > 9) tool.ArtifactPath = fields[9];
            return tool;
        }

        public override string ToString()
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} ({1}) - {2}",
                string.IsNullOrEmpty(DisplayName) ? Id : DisplayName,
                Version,
                Type);
        }
    }
}
