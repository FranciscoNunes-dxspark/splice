export const HELP = `Anywhere
  1-7 / tab        Graph, Changes, Branches, Worktrees, Stash, PRs, Repos (shift+tab goes back)
  / or :           Command prompt (slash commands, with completion)
  !                Run any git command, e.g.  !log --stat -5
  f  p  P          Fetch all · Pull · Push (sets the upstream the first time)
  r                Refresh
  esc              Cancel the running command, or clear the activity lines
  ?                This help
  q / ctrl+c       Quit

Lists
  j k / ↑ ↓        Move            g G         Top, bottom
  ctrl+d ctrl+u    Page down, up   J K         Scroll the right-hand pane

Graph
  ↵                Full diff of the commit
  c                Check out (its branch if it has one, otherwise detached)
  b  t             New branch here · New tag here
  m                Merge it into the current branch
  C  v             Cherry-pick · Revert
  X                Reset the current branch to it (soft, mixed or hard)
  i                Interactive rebase from it (included) up to HEAD
  e  R             Claude explains it · Claude reviews it (R on the working tree: your changes)

Rebase editor (newest on top, like the graph)
  p r e            Pick · Reword (then type the message: /reword <message>) · Edit (stop there)
  s f              Squash · Fix up: fold into the commit below, keeping or dropping its message
  d                Drop            J K         Move the commit down, up
  ↵                Start (asks first)          esc         Cancel

Changes
  space            Stage or unstage the file (on a conflict: mark it resolved)
  a  u             Stage all · Unstage all
  d                Discard the file's changes
  c  A             Commit · Amend the last commit
  F                Fix up an earlier commit with the staged changes (pick it; then fold it in, or keep it for later)
  W             Claude writes the commit message for the staged changes, into the prompt to edit
  R                Claude reviews the staged changes (or the unstaged ones, if nothing is staged)
  O  T             On a conflict: take ours · take theirs
  H  B             The file's history · Blame it (who last changed each line)
  ↵  →  l          Step into the diff to stage hunks or single lines

Changes, in the diff
  j k              Move between changed lines      n N  ] [    Next, previous hunk
  space            Stage the hunk under the cursor (unstage it, for a staged file)
  v                Start or end a line selection; space then stages just those lines
  d                Discard the hunk or the selected lines (asks first)
  ↵                Full-screen diff        esc  ←  h    Back to the file list

File history (H, /history <path>: the commits that touched it, following renames)
  ↵                The commit's diff of the file (esc comes back here)
  B                Blame the file as it was in that commit

Blame (B, /blame <path>: the working-tree file, so new lines show as not committed yet)
  ↵                Diff of the commit that last changed the line (esc comes back here)
  H                The file's history

Branches
  ↵                Check out (a remote branch gets a local tracking branch)
  n                New branch from it
  m  e             Merge it in · Rebase onto it
  d                Delete (asks before force-deleting or deleting on the remote)
  D                Full diff of what it adds to the default branch (/compare <ref> [base])
  o                Open its pull request in the browser (#12 GitHub, !12 Azure DevOps; coloured by review)
  The right-hand pane: how far it is ahead of and behind the default branch, its commits the default
  branch doesn't have, then its history
  C                Clean up: delete branches with nothing unpushed or unmerged, and clean worktrees (/cleanup)

Worktrees (● the one open here)
  ↵                Open it in Tiller
  n                New worktree (/worktree <path> [ref]; the path is relative to the repository)
  x                Remove it (asks first; the branch stays), or prune one whose folder is gone
  C                Clean up: remove worktrees without changes, and branches with nothing unpushed (/cleanup)

Stash
  ↵                Full diff       s           Stash the current changes
  a  o  x          Apply · Pop · Drop

PRs (GitHub through gh, Azure DevOps through az: your existing sign-in)
  ◆ asks for your review · ● yours · others below
  ↵                Full diff       c           Check out its branch
  a                Approve         C           Comment (/comment <text>)
  o                Open in the browser
  n                New pull request from the current branch (/pr <title> [--into <branch>] [--draft])
  W                Claude drafts one: title into the prompt, description offered when you open it
  e  R             Claude explains it · Claude reviews it

Claude (through the Claude Code CLI, signed in as you already are; answers take several seconds, esc cancels)
  /describe   /draft-pr [--into <branch>]   /explain [ref]   /review [ref]

Repos
  ↵                Open            x           Forget (remove from recent)
  s                Add a folder to scan for repositories

Prompt
  tab              Complete        ↑ ↓         Pick a suggestion, or walk history
  esc              Back to the view (the text is kept)
  ctrl+u ctrl+w    Clear the line · Delete a word

Slash commands
  /commit <msg>   /amend [msg]   /checkout <ref>   /branch <name> [start]
  /delete <ref>   /merge <ref>   /rebase <ref>     /reset <ref>   /tag <name> [ref]
  /fetch   /pull [--rebase]   /push [--force]   /stash [msg]   /pop   /discard
  /continue   /abort   /find <text>   /open <path>   /scan <folder>   /last   /quit
  /find -S <text>   /find -G <regex>   Search all history for commits adding or removing the text,
                                     or changing lines that match the regex
  /pr <title> [--into <branch>] [--draft]   /comment <text>   /approve
  /rebase -i <ref>   /reword <message>   /fixup [ref]   /worktree <path> [ref]   /compare <ref> [base]
  /history <path>   /blame <path>   /cleanup

Viewer (diffs, output, this help)
  j k  space  g G  Scroll         n N         Next, previous hunk
  esc / q          Close`;
