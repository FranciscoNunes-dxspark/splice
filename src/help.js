export const HELP = `Anywhere
  1-6 / tab        Graph, Changes, Branches, Stash, PRs, Repos (shift+tab goes back)
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
  O  T             On a conflict: take ours · take theirs
  ↵  →  l          Step into the diff to stage hunks or single lines

Changes, in the diff
  j k              Move between changed lines      n N  ] [    Next, previous hunk
  space            Stage the hunk under the cursor (unstage it, for a staged file)
  v                Start or end a line selection; space then stages just those lines
  d                Discard the hunk or the selected lines (asks first)
  ↵                Full-screen diff        esc  ←  h    Back to the file list

Branches
  ↵                Check out (a remote branch gets a local tracking branch)
  n                New branch from it
  m  e             Merge it in · Rebase onto it
  d                Delete (asks before force-deleting or deleting on the remote)

Stash
  ↵                Full diff       s           Stash the current changes
  a  o  x          Apply · Pop · Drop

PRs (GitHub through gh, Azure DevOps through az: your existing sign-in)
  ◆ asks for your review · ● yours · others below
  ↵                Full diff       c           Check out its branch
  a                Approve         C           Comment (/comment <text>)
  o                Open in the browser
  n                New pull request from the current branch (/pr <title> [--into <branch>] [--draft])

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
  /fetch   /pull [--rebase]   /push [--force]   /stash [msg]   /pop
  /continue   /abort   /find <text>   /open <path>   /scan <folder>   /last   /quit
  /pr <title> [--into <branch>] [--draft]   /comment <text>   /approve
  /rebase -i <ref>   /reword <message>

Viewer (diffs, output, this help)
  j k  space  g G  Scroll         n N         Next, previous hunk
  esc / q          Close`;
