export const HELP = `Anywhere
  1-5 / tab        Graph, Changes, Branches, Stash, Repos (shift+tab goes back)
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

Changes
  space            Stage or unstage the file (on a conflict: mark it resolved)
  a  u             Stage all · Unstage all
  d                Discard the file's changes
  c  A             Commit · Amend the last commit
  O  T             On a conflict: take ours · take theirs
  ↵                Full diff

Branches
  ↵                Check out (a remote branch gets a local tracking branch)
  n                New branch from it
  m  e             Merge it in · Rebase onto it
  d                Delete (asks before force-deleting or deleting on the remote)

Stash
  ↵                Full diff       s           Stash the current changes
  a  o  x          Apply · Pop · Drop

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

Viewer (diffs, output, this help)
  j k  space  g G  Scroll         n N         Next, previous hunk
  esc / q          Close`;
