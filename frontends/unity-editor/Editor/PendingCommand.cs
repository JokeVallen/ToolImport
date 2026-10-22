using System;

namespace ToolImport.Editor
{
    /// <summary>
    /// One command waiting for the in-flight one to finish.
    /// </summary>
    /// <remarks>
    /// LAST-WINS, and that is the whole point. The editor window runs one backend call at a
    /// time, so a request made while another is running has to wait. Keeping the FIRST waiting
    /// request instead - which is what the window used to do, despite a comment claiming
    /// otherwise - paints a superseded answer over the newest one: pick release 0.9.0, see
    /// 1.0.0's details, pick 1.0.0 and see 0.9.0. The pane can show exactly one thing, so the
    /// only request worth running is the newest.
    ///
    /// A separate type rather than a field on the window because this is policy, not drawing:
    /// it can be checked without an editor, and the check below is why the next reader can
    /// trust the comment.
    /// </remarks>
    internal sealed class PendingCommand
    {
        private Action pending;

        /// <summary>True when something is waiting to run.</summary>
        public bool HasPending => pending != null;

        /// <summary>Replace whatever was waiting with this command.</summary>
        public void Post(Action command)
        {
            if (command == null) return;
            pending = command;
        }

        /// <summary>Take the waiting command, leaving the slot empty.</summary>
        public Action Take()
        {
            Action next = pending;
            pending = null;
            return next;
        }
    }
}
