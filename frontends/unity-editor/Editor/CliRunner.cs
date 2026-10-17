using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace ToolImport.Editor
{
    /// <summary>
    /// Runs the <c>utool</c> backend CLI and returns its JSON output.
    /// </summary>
    /// <remarks>
    /// This class is the entire reason the tool is split into a backend and an
    /// editor front end. Every decision that could be got wrong -- parsing
    /// .yaml, resolving dependencies, verifying a sha256, deciding install
    /// order -- happens in Node, outside Unity. Consequences that matter:
    ///
    ///   * if the project has compile errors, no editor assembly loads and this
    ///     class never runs, but the CLI still works from a shell;
    ///   * the same backend can serve another engine later, because nothing here
    ///     is Unity-specific;
    ///   * the rules are testable without an editor (see utool-core/test).
    ///
    /// Nothing in this class inspects .yaml files itself. If a rule needs
    /// changing, it changes in the backend.
    /// </remarks>
    internal static class CliRunner
    {
        /// <summary>Environment variable that overrides the CLI location.</summary>
        internal const string CLI_PATH = "UTOOL_CLI";
        internal const string NODE = "UTOOL_NODE";

        /// <summary>Result of one CLI invocation.</summary>
        internal sealed class CliResult
        {
            public int ExitCode;
            public string StdOut = string.Empty;
            public string StdErr = string.Empty;
            public bool Ok { get { return ExitCode == 0 && string.IsNullOrEmpty(StdErr); } }
            public string Message { get { return string.IsNullOrEmpty(StdErr) ? StdOut : StdErr; } }
        }

        /// <summary>
        /// Locate the CLI.
        /// </summary>
        /// <remarks>
        /// Resolution order:
        ///   1. the settings window (EditorPrefs), which is what a user sets deliberately;
        ///   2. the UTOOL_CLI environment variable (an absolute path to the .js);
        ///   3. a sibling checkout of the import-tool repository, which is how
        ///      this is used during development.
        ///
        /// The settings window comes first because an environment variable is usually
        /// inherited from a shell, and letting it silently override an explicit choice
        /// would be baffling. Returns null when none exists, so the UI can show an
        /// actionable message instead of throwing from a menu callback.
        /// </remarks>
        internal static string ResolveCliPath()
        {
            string fromSettings = ReadPreference(ImportToolSettingsWindow.CLI_PREF_KEY);
            if (!string.IsNullOrEmpty(fromSettings) && File.Exists(fromSettings))
            {
                return fromSettings;
            }

            string fromEnvironment = Environment.GetEnvironmentVariable(CLI_PATH);
            if (!string.IsNullOrEmpty(fromEnvironment) && File.Exists(fromEnvironment))
            {
                return fromEnvironment;
            }

            // Walk up from the project looking for the import-tool checkout.
            var directory = new DirectoryInfo(UnityEngine.Application.dataPath);
            for (int depth = 0; directory != null && depth < 6; depth++)
            {
                string candidate = Path.Combine(directory.FullName, "ToolImport", "apps", "cli", "bin", "utool.js");
                if (File.Exists(candidate)) return candidate;
                directory = directory.Parent;
            }

            return null;
        }

        /// <summary>
        /// Read an EditorPrefs value, tolerating a missing or corrupt one.
        /// </summary>
        /// <remarks>
        /// A bad preference should fall through to the next resolution rule rather than
        /// abort the lookup, which is why this never throws.
        /// </remarks>
        private static string ReadPreference(string key)
        {
            try
            {
                return UnityEditor.EditorPrefs.GetString(key, string.Empty);
            }
            catch
            {
                return string.Empty;
            }
        }

        /// <summary>Locate the Node executable.</summary>
        internal static string ResolveNodePath()
        {
            string fromSettings = ReadPreference(ImportToolSettingsWindow.NODE_PREF_KEY);
            if (!string.IsNullOrEmpty(fromSettings) && File.Exists(fromSettings))
            {
                return fromSettings;
            }

            string fromEnvironment = Environment.GetEnvironmentVariable(NODE);
            if (!string.IsNullOrEmpty(fromEnvironment) && File.Exists(fromEnvironment))
            {
                return fromEnvironment;
            }
            // "node" relies on PATH; that is the common case for a developer box.
            return "node";
        }

        /// <summary>
        /// Run a CLI command.
        /// </summary>
        /// <param name="arguments">Arguments after the script, e.g. "list --json".</param>
        /// <param name="workingDirectory">Directory to run in; defaults to the project root.</param>
        internal static Task<CliResult> RunAsync(string arguments, string workingDirectory = null)
        {
            string cli = ResolveCliPath();
            if (cli == null)
            {
                return Task.FromResult(new CliResult
                {
                    ExitCode = 127,
                    StdErr =
                        "The utool backend CLI was not found.\n" +
                        $"Set the '{CLI_PATH}' environment variable to the absolute path of " +
                        "apps/cli/bin/utool.js, or place a ToolImport checkout beside this project.",
                });
            }

            string node = ResolveNodePath();
            string cwd = workingDirectory ?? Directory.GetParent(UnityEngine.Application.dataPath).FullName;

            return Task.Run(() =>
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = node,
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                // ArgumentList avoids all quoting problems with paths that
                // contain spaces (which Windows project paths usually do).
                startInfo.ArgumentList.Add(cli);
                foreach (string argument in SplitArguments(arguments))
                {
                    startInfo.ArgumentList.Add(argument);
                }

                var result = new CliResult();
                try
                {
                    using (var process = new Process { StartInfo = startInfo })
                    {
                        var stdout = new StringBuilder();
                        var stderr = new StringBuilder();
                        process.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
                        process.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

                        process.Start();
                        process.BeginOutputReadLine();
                        process.BeginErrorReadLine();
                        process.WaitForExit();

                        result.ExitCode = process.ExitCode;
                        result.StdOut = stdout.ToString().TrimEnd();
                        result.StdErr = stderr.ToString().TrimEnd();
                    }
                }
                catch (Exception exception)
                {
                    result.ExitCode = 1;
                    result.StdErr = $"Failed to start the backend CLI: {exception.Message}";
                }

                return result;
            });
        }

        /// <summary>
        /// Split a command line into arguments, honouring double quotes.
        /// </summary>
        /// <remarks>
        /// The backend takes one value per flag, and paths may contain spaces, so
        /// quoting has to be respected rather than split on every space.
        /// </remarks>
        internal static List<string> SplitArguments(string commandLine)
        {
            var arguments = new List<string>();
            if (string.IsNullOrWhiteSpace(commandLine))
            {
                return arguments;
            }

            var current = new StringBuilder();
            bool inQuotes = false;
            bool hasContent = false;

            foreach (char character in commandLine)
            {
                if (character == '"')
                {
                    inQuotes = !inQuotes;
                    hasContent = true;
                    continue;
                }

                if (char.IsWhiteSpace(character) && !inQuotes)
                {
                    if (hasContent)
                    {
                        arguments.Add(current.ToString());
                        current.Clear();
                        hasContent = false;
                    }
                    continue;
                }

                current.Append(character);
                hasContent = true;
            }

            if (hasContent)
            {
                arguments.Add(current.ToString());
            }
            return arguments;
        }
    }
}
