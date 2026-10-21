<p align="center"><img src="assets/logo.svg" width="128" alt="Twig, the Splice beaver"></p>

# Splice

A keyboard-driven git client for the terminal, with an interface modelled on Claude Code: titled rounded panels, a prompt box with slash commands and completion, `!` to run any git command, and a running log of what each command did.

Splice used to be called Tiller. A Tiller that updates itself becomes Splice on its own (the executable keeps its old file name until you rename it), and your recent repositories and settings in `~/.tiller` carry over.

```
(•Π•) Splice  │  Keel  ⎇ main → origin/main ↑1  ● 2 changes                              C:\Team\Keel
 1 Graph   2 Changes 2   3 Branches   4 Worktrees   5 Stash   6 PRs   7 Repos
╭─ Commits ────────────────────────────────── 125 ─╮╭─ Commit ──────────────── J/K scroll ─╮
│❯ ◌    // WIP  2 changed files                    ││4e9f0080cb  19/10/2026, 15:14:35      │
│  ●    ● main ⇅ origin  Compact view on the Pro…  ││Francisco Nunes                       │
│  ○<╮ Merge pull request #27 from …               ││                                      │
│  │ │                                             ││Compact view on the Production page   │
│  ● │ Add CLAUDE.md for Claude Code               ││                                      │
│  │ ●  origin/ccr-618ea99b  Don't show an old …   ││6 files changed                       │
│  ├─╯                                             ││M README.md                           │
╰──────────────────────────────────────────────────╯╰──────────────────────────────────────╯
● git push
  ⎿  To github.com:you/keel.git
     4e9f008..d9c8c5a  main -> main
╭──────────────────────────────────────────────────────────────────────────────────────────╮
│ > /checkout feat                                                                         │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
  feature/login
  feature/totals
```

## Install

**Download** the executable for your platform from [Releases](https://github.com/FranciscoNunes-dxspark/splice/releases): `splice-windows-x64.exe`, `splice-linux-x64` / `-arm64`, `splice-macos-arm64` / `-x64`. It's a single file with nothing else to install; it only needs git on the PATH. Rename it to `splice` (`splice.exe`) and put it in a folder on your PATH. `SHA256SUMS.txt` lists each file's checksum.

The builds aren't code-signed, so Windows SmartScreen may ask before the first run ("More info" → "Run anyway"), and on macOS you may need `xattr -d com.apple.quarantine splice-macos-arm64` once.

**From source** (Node 22+):

```bash
cd C:\Team\Splice
npm install
npm link          # puts a `splice` command on your PATH
```

Without `npm link`, run it with `node C:\Team\Splice\bin\splice.js`.

## Use

```bash
splice              # the repository you're in (outside one: the repository you had open last)
splice C:\Team\Keel # a specific one
splice C:\Team      # not a repository: lists the ones it finds inside
```

Press `?` inside for every shortcut: the sections down the left, opening on the one for the view you're in, `j`/`k` to pick another, and `/` to search them all (the slash commands too). The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`7` or `tab` switch views · `/` commands · `!` any git command · `f` fetch · `p` pull · `P` push · `r` refresh · `z` undo the last commit, merge, rebase, reset, switch or discard · `,` settings · `esc` cancel the running command · `q` quit · drop a folder on the terminal to open it, or a file for its history |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page · `J`/`K` scroll the right-hand pane · `y` copy what's under the cursor: a commit's hash, a branch name, a file's path, a stash's message, a PR's link |
| Graph | `↵` full diff · `c` check out · `b` branch here · `t` tag here · `m` merge · `s` checks: `↵` a check's log, `R` re-run the failed ones · `A` add reviewers · `D` draft or ready · `E` retitle · `B` edit the description · `i` interactive rebase from here · `C` cherry-pick · `V` select several commits, then `C` cherry-picks them all · `v` revert · `X` reset to here · `B` bisect: mark it bad or good, or have a command test each · `e` / `R` Claude explains / reviews it |
| Rebase editor | `p` pick · `r` reword · `e` edit · `s` squash · `f` fix up · `d` drop · `J`/`K` move · `↵` start · `esc` cancel |
| Changes | `space` stage/unstage · `↵` step into the diff · `a` stage all · `u` unstage all · `d` discard · `i` ignore an untracked file · `s` stash just this file · `v` select several files, then `s` stashes them · `c` commit · `A` amend · `M` write the message in your own editor · `F` fix up an earlier commit · `H` the file's history · `B` blame · `W` Claude writes the message · `S` Claude splits your changes into commits · `R` Claude reviews · on conflicts `↵` resolve block by block, `O` ours / `T` theirs for the whole file, `C` Claude proposes a resolution · on a submodule `I` initialise or update it, `o` open it |
| File history | `↵` the commit's diff of the file · `B` blame as of that commit · `esc` close |
| Blame | `↵` diff of the commit behind the line · `H` the file's history · `v` select lines, then `L` every commit that changed them · `e` Claude explains why they are the way they are · `esc` close |
| Changes, in the diff | `j`/`k` changed lines · `n`/`N` hunks · `space` stage (or unstage) the hunk · `v` select lines, then `space` stages just those · `d` discard them · `s` stash them · `w` side by side or in one column · `esc` back |
| Changes, in a conflict | `j`/`k` or `n`/`N` conflict blocks · `o` take ours · `t` take theirs · `b` keep both · `esc` back |
| Branches | `↵` check out (remote branches get a tracking branch) · `n` new from here · `m` merge · `e` rebase onto · `d` delete · `D` diff with the default branch · `o` open its pull request · `C` clean up · `U` set a local branch's upstream · `M` the remotes: add, rename, remove, change a URL, fetch or push to one · on a tag: `u` push it, `d` delete it here or on the remote, `R` create a GitHub or GitLab release |
| Worktrees | `↵` open · `n` new · `x` remove (or prune one whose folder is gone) · `C` clean up |
| Stash | `↵` diff · `s` stash · `S` stash with a message · `a` apply · `o` pop · `x` drop · `F` its files, to restore one (`↵`) or see its diff (`d`) |
| PRs | `↵` diff, with its review comments (`j`/`k` move the line cursor, `h`/`l` to the old or new side when side by side, `c` comment on its line, `t`/`T` from one comment to the next, `r` reply, `x` resolve or reopen) · `c` check out · `w` review it in a worktree of its own · `a` approve · `X` request changes · `m` merge · `C` comment · `o` open in the browser · `n` new PR from the current branch · `W` Claude drafts one · `e` / `R` Claude explains / reviews it |
| Reflog (`/reflog`) | `↵` the commit's diff · `X` reset the current branch to it · `c` check it out |
| Repos | `↵` open · `F` fetch them all · `s` add a folder to scan · `x` forget |
| Viewer (diffs, output, help, Claude's answers) | `j`/`k` scroll · `space` page · `n`/`N` next or previous hunk · `w` a diff side by side, or back in one column · `y` copy release notes (`/changelog`) · `/` search: matches show as you type, `↵` keeps the search, then `n`/`N` go from match to match · `esc` clears the search, then closes |

The mouse works too: click a tab, a row or the prompt, double-click a row to do what `↵` does, and scroll the list or pane under the pointer with the wheel. In Changes, clicking a `+` or `-` line puts the cursor in the diff, ready to stage that hunk with `space`. Drag to select text as you would in the terminal: it's copied when you let go (to the system clipboard, or through the terminal over SSH), and stays highlighted until the next key or click. With the mouse turned off in the settings, the terminal does its own selecting again. On Windows the downloaded Splice handles the mouse itself; run from a checkout, it needs Node 22.17 or later.

**Dropping a folder** on the terminal (from Explorer, Finder or a file manager) opens it, as `/open` does; a folder that isn't a repository shows the Repos view with the ones found inside it, as `splice <folder>` does. Dropping a file of the open repository shows its history, as `/history` does. The terminal types a dropped path, so Splice takes it as a drop when what arrives at once is nothing but the path of something that's there (quoted or not, Windows paths and `file://` links too), anywhere but the prompt, where it's just text.

### Slash commands

Type `/` and the menu narrows as you type; `tab` completes, `↑`/`↓` picks, `↵` runs. Commands that take a branch complete branch, tag and remote names; `/history` and `/blame` complete the repository's tracked files.

`/commit <msg> | --file [path]` `/amend [msg | --file [path]]` `/checkout <ref>` `/branch <name> [start]` `/delete <ref>` `/merge <ref>` `/rebase <ref>` `/reset <ref>` `/tag <name> [ref]` `/tag-push <tag> [remote]` `/release <tag> [--draft] [--notes-file <path>] [title]` `/fetch` `/pull [--rebase]` `/push [--force] [remote]` `/remote [add|rename|remove|set-url] …` `/upstream [branch] <remote/branch>` `/stash [-u | --no-untracked] [msg]` `/pop` `/discard` `/submodule-update [path]` `/undo` `/reflog` `/continue` `/abort` `/find <text>` `/find -S <text>` `/find -G <regex>` `/filter [--author <name>] [--path <path>] [--since <date>] [--until <date>]` `/fixup [ref]` `/open <path>` `/scan <folder>` `/last` `/settings` `/accent <#rrggbb|default>` `/refresh` `/help` `/quit` `/pr <title> [--into <branch>] [--draft]` `/comment <text>` `/review-comment <text>` `/reply <text>` `/resolve` `/unresolve` `/approve` `/request-changes [text]` `/merge-pr [squash|merge|rebase] [--delete-branch] [--auto]` `/ci` `/reviewer <name>` `/draft` `/ready` `/title <text>` `/body [--file <path>]` `/worktree <path> [ref]` `/compare <ref> [base]` `/history <path>` `/blame <path>` `/cleanup` `/describe` `/split` `/draft-pr [--into <branch>]` `/ship [--into <branch>]` `/review-pr <number>` `/backport <pr-number> <branch>` `/changelog [since-tag] [--into-release <tag>]` `/explain [ref]` `/review [ref]` `/cherry-pick <ref | a..b>` `/range-diff [branch | <a> <b>]` `/bisect <good|bad|skip|reset> [ref]` `/bisect run <command…>` `/ignore <pattern>`

### Commit messages

`c` puts `/commit ` in the prompt: type the message and press enter. `\n` makes a line break, so `/commit Fix the poll\n\nIt reloaded twice.` gives a subject and a body. `A` does the same for `/amend`, which keeps the commit's message if you don't give one.

For a longer message, `M` writes it to a file in `.git` and puts `/commit --file <that file>` in the prompt: edit the file in your own editor, save, and press enter to commit (Splice never opens an editor itself). The file starts with whatever you'd typed after `/commit` in the prompt, and lists what's staged in lines starting with `#`, which are left out of the message, as git does. With `/amend` in the prompt, `M` writes the amended commit's message instead, starting from what you typed after it or else the commit's own message, and puts `/amend --file …` in the prompt; `/commit --file` and `/amend --file` alone do the same as `M`. A commit message you wrote but didn't commit stays in the file for the next `M`, and the file goes once the commit is made. `/commit --file <path>` commits with the message in any file.

### Branches

The Branches view (`3`) compares each branch with the default branch: the remote's own default (`origin/HEAD`), or else `main` or `master`. The right-hand pane shows how far the selected branch is ahead and behind, the commits it has that the default branch doesn't, then its earlier history. `D` opens the full diff of what the branch adds, as a pull request would show it; `/compare <ref> [base]` does the same for any ref, against any base. Branches with an open pull request show its number (`#12` on GitHub, `!12` on Azure DevOps and GitLab), coloured by its review state (green approved, red changes requested, yellow waiting), and its checks; `o` opens it in the browser.

**Remotes and upstreams.** `M` (or `/remote`) lists the remotes with their URLs: `n` adds one (`/remote add <name> <url>`), `R` renames it, `u` changes its URL, `x` removes it after asking (that only forgets it here), `f` fetches it, and `p` pushes the current branch to it. `/push <remote>` does the same from the prompt: the branch goes to that remote under its own name, and becomes its upstream only if it had none. `U` on a local branch puts `/upstream <branch> <remote>/<branch>` in the prompt, to change what the branch tracks; `/upstream --unset [branch]` stops it tracking anything.

**Tags** are listed at the bottom, newest first (`t` on a commit in the graph makes one). On a tag, `u` pushes it to `origin` (`/tag-push <tag> [remote]` for another remote), and `d` deletes it, after asking whether here, on the remote, or both. `R` creates a GitHub or GitLab release for it (`/release <tag> [--draft] [title]`): Splice pushes the tag first, then asks GitHub (through `gh release create`) to publish the release, or save it as a draft, with notes GitHub writes from what was merged since the last one. GitLab has no draft releases, and writes no notes, so there Splice publishes it with the subjects of the commits since the tag before it as the notes. Azure DevOps has no releases made from tags, so there `R` just says so. `--notes-file <path>` gives the notes yourself, from a Markdown file, instead (in quotes if the path has spaces); `/changelog --into-release <tag>` writes them with Claude and passes them on that way (see [Release notes](#release-notes)).

### Interactive rebase

On a commit in the graph, `i` opens the commits from that one up to HEAD, newest on top. Mark each as pick, reword, edit, squash, fix up or drop, move them with `J`/`K`, and press `↵`. Squash and fix up fold a commit into the one drawn below it. Reword asks for the new message in the prompt (`/reword <message>`). `/rebase -i <ref>` does the same for the commits after `<ref>`.

Before it starts, Splice says how many commits it will rewrite and warns if any are already pushed (you'd need `/push --force` afterwards). It refuses while you have uncommitted changes, and on ranges with merge commits, which a rebase would flatten. No editor ever opens: Splice writes git's todo list itself, and rewords by amending from a file. If it stops on a conflict or an `edit`, fix things up and `/continue`, or `/abort` to put the branch back.

**What did the rebase change?** Once a rebase (or a fixup folding in) has rewritten the branch, the activity line points to `/range-diff`. It compares the branch as it was before its last rewrite, whether a rebase, an amend or a reset, with how it is now, commit by commit (`git range-diff`): `=` for a commit that came through the same, `!` for one that changed, with the changes to its message and its diff underneath, and `<` or `>` for one only before or only after. After a rebase onto a branch that had moved on, only your own commits are compared, not the ones you rebased over. `/range-diff <branch>` looks back on another branch, and `/range-diff <a> <b>` compares any two versions, such as `feature@{2} feature`.

**Fixups.** To fix an earlier commit, stage the fix and press `F` in Changes (or `/fixup [ref]`). Pick the commit from the list of the branch's commits that aren't on its upstream or the default branch yet (or the latest 30, if there are none). Splice commits the fix as `fixup! <subject>` and asks whether to fold it in now: yes runs an autosquash rebase from that commit's parent, setting your other uncommitted changes aside meanwhile (`--autostash`); no keeps the fixup! commit for later. It warns when the commit is already pushed, and won't fold across merge commits. With nothing staged, it offers to stage everything first.

### Finding the commit that broke something

`B` on a commit in the graph starts a bisect: say whether that commit is bad (it has the problem) or good (from before it), then do the same on one of the other kind. Git checks out a commit halfway between, and the cursor goes to it: try it, then `B` again to mark it bad, good, or skipped if you can't tell (it doesn't build, say). Each answer halves what's left, so a few steps name the first bad commit. Marked commits carry `bad` and `good` labels in the graph, and the header says BISECTING until `/abort` (or `/bisect reset`) puts you back where you started. `/bisect good|bad|skip [ref]` does the same from the prompt.

Once one bad and one good commit are marked, git can do the trying for you: `/bisect run <command>` (or `B`, then "Run a command") runs the command on each commit git checks out, such as `/bisect run npm test`. Its exit code is the answer: 0 means good, 125 means skip (this commit can't be tested), any other code up to 127 means bad, and 128 or more stops the run. The output shows when it's done, and the cursor goes to the first bad commit. Git runs the command in its own shell (on Windows, the one that comes with Git for Windows), from the top of the repository, so give a script, or `sh -c "…"` for anything that needs `&&` or a pipe. `esc` stops it, and what it was running, leaving the bisect where it got to.

### Cherry-picking

`C` on a commit in the graph copies it onto the current branch, after asking; a merge commit is copied as what it brought into the branch it was merged into. For several, press `V` on the first, move to the last and press `C`: Splice lists them, oldest first, leaving out any the branch already has, and picks them all in one go. If one stops on a conflict, fix it in Changes and `/continue` goes on with the rest (or `/abort` puts the branch back). Merge commits can't be part of a selection, since each would need its own choice of side: pick those on their own. `/cherry-pick <ref>` and `/cherry-pick <a>..<b>` (the commits `b` has that `a` doesn't) do the same from the prompt.

### Ignoring files

`i` on an untracked file in Changes asks what to ignore: just that file, its whole folder, every file with its extension, or (for a file in a subfolder) the file in that folder's own `.gitignore`. Splice adds the line to the repository's `.gitignore` (making one if there isn't one yet, and keeping its line endings), with paths anchored to where they are, so `/logs/` ignores that folder and no other. The file leaves the list, and the `.gitignore` shows up as a change to commit. `/ignore <pattern>` adds a pattern as you type it. A file git already tracks can't be ignored this way: `!rm --cached <path>` stops tracking it while keeping it on disk, then `i` ignores it.

### File history and blame

On a file in Changes, `H` lists the commits that touched it, newest first, following it through renames: each with its hash, age, author and subject, plus the name the file had then if it was different. `↵` shows that commit's changes to the file, and `esc` brings the list back. `/history <path>` does the same for any file, including one that has since been deleted. Paths are relative to the repository's root, and the prompt completes them.

`B` (or `/blame <path>`) shows the file line by line, with who last changed each line, in which commit and when, written once at the top of each run of lines from the same commit. It blames the file as it is on disk, so lines you haven't committed yet say so. `↵` on a line shows the commit that last changed it, and `H` switches to the file's history. From the history, `B` blames the file as it was in the selected commit.

To see how a few lines came to be, put the cursor on the first in blame, press `v`, move to the last, and press `L` (or just `L` for the line under the cursor). Every commit that changed them is listed with what it did to those lines, newest first (`git log -L`), following them as other lines move around them. Lines you've changed but not committed are matched to where they were in the last commit; ones you've only just written have no history yet.

`e` instead asks Claude why those lines are the way they are, from the commits that changed them (see [Claude](#claude)).

### Pull requests

The PRs view (`6`) lists the open pull requests of the repository's remote, on **GitHub**, **Azure DevOps** (`dev.azure.com` and `*.visualstudio.com`) or **GitLab** (merge requests, on `gitlab.com` or a server of your own). Ones asking for your review come first (◆), then yours (●). The right-hand pane shows reviewers and their votes, checks (GitHub checks, Azure DevOps branch policies, the jobs of GitLab's latest pipeline), the description and comments, with their Markdown formatted (headings, bold, lists, code, links, tables). The list refreshes every minute while you're on it, and on `r`; when the checks of one of yours finish, or a review lands on it, Splice notifies you (see [How it behaves](#how-it-behaves)).

Splice talks to the servers through their own CLIs, using the sign-in you already have, so it never sees or stores a token:

- GitHub: [gh](https://cli.github.com), signed in with `gh auth login`.
- Azure DevOps: [az](https://aka.ms/installazurecliwindows) with the `azure-devops` extension (`az extension add --name azure-devops`), signed in with `az login`.
- GitLab: [glab](https://gitlab.com/gitlab-org/cli), signed in with `glab auth login` (`glab auth login --hostname gitlab.example.com` for your own server). Splice knows a remote is on GitLab when its server is `gitlab.com` or has "gitlab" in its name; for one that doesn't, say so in the settings file: `"hosts": { "git.example.com": "gitlab" }`.

Bitbucket has no official CLI to sign in with, so Splice doesn't show its pull requests.

**Review comments in the diff.** `↵` on a pull request shows its diff with the reviewers' comments drawn under the lines they're about, each thread in a box with its replies, Markdown formatted. The diff has a line cursor: `j`/`k` move it (and a click puts it on a line), and `c` comments on the line it's on: the prompt fills with `/review-comment `, and the new thread shows under the line once it's posted. Added lines and the unchanged ones around them are commented on as they are in the pull request, removed lines as they were before; headers and lines outside the diff can't take a comment, and Splice says so. `t` and `T` go from one thread to the next (moving the cursor into a thread picks it too), `r` replies to the one picked (or the first on screen) through `/reply `, and `x` marks it resolved, or opens a resolved one again (`/resolve`, `/unresolve`). Comments on lines the diff no longer shows (the code changed since) are listed at the top. Resolved threads say so in their box: on Azure DevOps, the fixed and closed ones; on GitLab, the resolved discussions; on GitHub, the ones marked resolved there, read through its GraphQL API (should that fail, the comments still show, without saying which are resolved, and can't be resolved from Splice).

**Requesting changes.** `X` fills the prompt with `/request-changes `: say what needs changing and press enter, and Splice asks before sending it. On GitHub this is a review requesting changes, which needs the text; on Azure DevOps it votes "waiting for author", and posts the text as a comment if you typed one. GitLab has no "request changes" vote on every plan, so there Splice posts your text as a comment (it needs one) and takes back your approval if you had given it.

`/pr <title>` opens a pull request from the current branch into the repository's default branch (or `--into <branch>`), pushing the branch first if the server doesn't have your latest commits. Approving, requesting changes and opening a PR ask first; `/comment` posts as soon as you press enter. Azure DevOps and GitLab PR diffs are made locally: Splice fetches both branches (on GitLab, the merge request's own head, so ones from forks work too) and shows what the source branch adds. Listing Azure DevOps PRs takes a few seconds, most of it the az CLI starting up.

**Merging.** `m` (or `/merge-pr`) merges the pull request on the server. Splice asks how (squash, a merge commit, or rebase; Azure DevOps offers squash or a merge commit; on GitLab, rebase has GitLab rebase the branch first, and a merge then goes as the project is set to merge, with a merge commit or fast-forward), then when: now, or once its required checks and reviews pass (GitHub's auto-merge, Azure DevOps' auto-complete, GitLab's "merge when the pipeline succeeds"), and whether to delete the source branch on the server afterwards. `/merge-pr squash --delete-branch --auto` says it all at once and only asks to confirm. Your local copy of the branch is left alone; `f` fetches the merge.

**Checks.** `s` (or `/ci`) lists the pull request's checks, failed ones first. `↵` shows a check's log in the viewer: on GitHub, a GitHub Actions job's failed steps (or the whole log, if it didn't fail), through `gh run view`; on Azure DevOps, the logs of a build policy's failed steps; on GitLab, the job's whole log, without its colours. Checks run elsewhere (an external CI service) have no log here; `o` opens any check's page in the browser. `R` re-runs the failed checks, after asking: the failed jobs of their GitHub Actions runs, the failed Azure DevOps policies queued again, or the failed jobs of the GitLab pipeline retried.

**Reviewers, draft, title and description.** `A` fills the prompt with `/reviewer `: name one or more people (GitHub logins, GitLab usernames, or Azure DevOps names or emails) to ask them for a review. `D` turns a draft into one ready for review, or back (`/draft`, `/ready`; on GitLab, by putting "Draft:" in front of the title or taking it off). `E` puts `/title` with the current title in the prompt, to edit and send. `B` writes the description to a file in `.git` and puts `/body --file <that file>` in the prompt: edit the file in your own editor, save, and press enter to send it (Splice never opens an editor itself). `/body <text>` sends a short one directly, with `\n` for a line break.

**Shipping a branch.** `/ship` does what's left once a feature branch is done, in one go: it pushes the branch (the first push setting its upstream, as `P` does), opens its pull request into the default branch (or `--into <branch>`) with the title and description Claude drafts, as `W` does (without Claude, the title is the latest commit's subject), and turns on auto-merge, so it merges as soon as its required checks and reviews pass, deleting the branch on the server then. A branch that has a pull request open already keeps it. Before it starts, the plan opens in the viewer and Splice asks; the first time in a repository, it also asks how to merge (squash, a merge commit or rebase, as `m` does) and remembers that for the next `/ship` there ("Merge another way" in the question changes it). Splice remembers the branches you shipped, and once one's pull request is merged it offers to finish: switch to the default branch, pull it, and delete the branch and its worktree, by the same rules as `/cleanup` (so a branch with commits that are only here, or a worktree with changes, stays). It notices while the PRs or Branches view polls the list, when you run `/ship` again on the branch, or on `/cleanup`. Say "No, and stop asking" to keep the branch and not be asked again. On a branch shipped before whose pull request is still open, `/ship` pushes what's new and turns auto-merge on again. On GitHub, a pull request that can be merged at once may be merged straight away.

**Reviewing in a worktree of its own.** `w` on a pull request (or `/review-pr <number>`) checks it out in a new worktree next to the repository, `../<repo>-pr-<n>` as `n` in Worktrees would name it, on a branch `pr-<n>`, and opens that in Splice, so your own work stays exactly as it is. Splice fetches the pull request's head from the server (GitHub's `refs/pull/<n>/head`, GitLab's `refs/merge-requests/<n>/head`, the source branch on Azure DevOps), so ones from forks work too. Running it again for the same pull request opens that worktree and brings it up to the latest commit; if the author rewrote the branch (a force-push), it asks before resetting to it. `/open` with the repository's own folder goes back. `/cleanup` removes the worktree when it has no changes, and the `pr-<n>` branch once the pull request is merged.

**Backporting.** `/backport <pr-number> <branch>` copies a merged pull request onto a release branch. Splice asks the server how it was merged and picks the commits to match: the merge commit as what it brought in (`-m 1`), the commit it was squashed into, or, for a rebase merge, each of the commits it was rebased as. It lists what it will do and asks; then it makes `backport/<n>-to-<branch>` from the remote's `<branch>`, cherry-picks with `-x` (so each message says where it came from), pushes the branch and opens a pull request into `<branch>`, titled `[<branch>] <original title>`, linking the original. If a commit stops on a conflict, the header says so as for any cherry-pick: resolve it in Changes, and `/continue` picks the rest, pushes and opens the pull request (`/abort` stops, leaving the branch). It needs a clean working tree, since it switches branches.

### Release notes

`/changelog` has Claude write release notes for what changed since the latest tag on the current branch (or since the tag you name, `/changelog v1.2`): from the commits, with their messages, and from the pull requests merged into the branch since then, which GitHub, GitLab (15.11 or later) and Azure DevOps (the latest 200) can list by when they were merged. They come grouped as features, fixes and other changes, in Markdown, and open in the viewer, where `y` copies them. `/changelog --into-release <tag>` writes them for a tag (from the tag before it up to it) and then creates that tag's release with them as its notes, as `/release` does, asking first. Azure DevOps has no releases made from tags, so there only `/changelog` alone works.

### Claude

With [Claude Code](https://claude.com/claude-code) installed and signed in, Splice can ask Claude to write and read changes for you. It runs `claude -p` with your existing sign-in, so Splice never sees a key. An answer takes several seconds, with the spinner showing; esc cancels.

- **Commit messages.** In Changes, `W` (or `/describe`) has Claude write the message for the staged changes, in the style of your recent commits: a subject line, and a short body when the change needs explaining. A subject alone lands in the prompt as `/commit …` for you to edit or just run. With a body, the message opens in the viewer and goes in the message file, as `M` writes it, with `/commit --file …` in the prompt: edit the file first, or just press enter.
- **Splitting a big change.** In Changes, `S` (or `/split`) has Claude group all your uncommitted changes, hunk by hunk, into a few logical commits, each with a message. Anything staged is unstaged first (after asking), and new files take part too. Splice then goes through the commits in order: each one opens as a diff with the question under it, to commit it (Splice stages just its hunks and commits them), skip it (its changes stay uncommitted), or stop. Whatever isn't committed is left as it was.
- **Pull requests.** In PRs, `W` (or `/draft-pr [--into <branch>]`) has Claude draft a title and description from the branch's commits and diff. The draft opens in the viewer and the title goes in the prompt as `/pr …`; opening it asks whether to include the description. `/ship` uses the draft as it is (see [Pull requests](#pull-requests)).
- **Release notes.** `/changelog` has Claude write them from the commits and merged pull requests since a tag (see [Release notes](#release-notes)).
- **Conflicts.** In Changes, `C` on a conflicted file has Claude propose the whole resolved file, from the file with its markers and the commit messages of both sides (it may read other files for context). The proposal opens as a diff against the file as it is; Splice asks before writing it, and leaves it unstaged for you to check and mark resolved.
- **Explain and review.** `e` explains and `R` reviews the commit under the cursor in the graph, or the pull request in PRs. In Changes (or on the working-tree row of the graph), `R` reviews your staged changes, or the unstaged ones if nothing is staged. `/explain [ref]` and `/review [ref]` do the same from the prompt. The answer opens in the viewer, its Markdown formatted.
- **Why lines are the way they are.** In blame, `e` asks Claude about the line under the cursor, or the lines selected with `v`. It gets the lines with who last changed each, the file around them, and every commit that changed them with its message (as `L` lists them, up to 30), and says how the lines came to be. The answer opens in the viewer, like an explanation.

Writing messages, splitting changes and writing release notes give Claude no tools at all. Explaining (blame lines too), reviewing and resolving conflicts let it read files in the repository for context (`Read`, `Grep`, `Glob`), but never change them or run anything. Diffs over 200,000 characters are cut, and Claude is told where. To save time, Splice starts Claude without MCP servers, settings files or skills, so your hooks and permission rules don't apply to these calls (they can't change anything anyway).

### Worktrees

The Worktrees view (`4`) lists the main working tree and every worktree added to it, each with its branch, how far it is ahead of or behind its upstream, and how many changed files it has. ● marks the one open here. The right-hand pane shows the selected worktree's changes and recent commits, and `↵` switches Splice to it.

`/worktree <path> [ref]` runs `git worktree add` with git's own defaults: the path is relative to the repository's root, a branch that only exists on one remote gets a local tracking branch, and with no ref git makes a new branch named after the folder. Flags pass through, so `/worktree -b fix ../fix main` works too. `n` in the view starts one next to the repository, as `../<repo>-`. Removing (`x`) asks first and leaves the branch alone; if the worktree has uncommitted changes, it asks again before forcing. A worktree whose folder was deleted shows as missing, and `x` prunes it.

### Cleaning up

`/cleanup` (or `C` in Branches or Worktrees) clears away the branches and worktrees that have nothing of yours left on them. When the repository is on GitHub, Azure DevOps or GitLab, it also asks there which pull requests were merged. It lists what would go and why in the viewer, then asks: everything, only what's here, only the branches, only the worktrees, only the branches on the remote, or nothing.

- **Worktrees** go when they have no uncommitted changes (ignored files don't count), and ones whose folder is gone are pruned. Never the main working tree or the one open in Splice. A worktree on a branch with unpushed commits can still go; the branch stays, and the list says so.
- **Branches** go when none of their commits exist only here: they're merged into the default branch (the remote's `HEAD`, else what GitHub, Azure DevOps or GitLab says, else `main` or `master`), or every commit is on a remote branch, or their pull request was merged with all their commits in it. That includes branches whose upstream was deleted after merging, squash-merged ones, and branches you pushed and haven't added to since (`↵` on the remote branch brings one back). Never the current branch, the default branch, or one checked out in a worktree that stays.
- **Pull requests you reviewed** with `w` (or `/review-pr`) are on a branch `pr-<n>`, which goes once pull request number `n` was merged with every commit it has, whether it came from a fork or not; its worktree goes like any other.
- **A branch you shipped** (`/ship`) that you're on, and whose pull request was merged, is finished first, after asking: Splice switches to the default branch and pulls it, then the branch goes with the rest.
- **Branches on the remote** go when their pull request was merged and nobody has pushed to them since. Never the default branch, or one that an open pull request comes from or goes into. One already deleted on the server just has its remote-tracking branch removed.

Worktrees are removed first with a plain `git worktree remove`, then branches deleted with `git branch -d`; `-D` is used only for branches it refuses because they aren't merged into the one you're on, which were already checked against the remotes, the default branch and the pull requests. Branches on the remote go last, with `git push --delete`. Something that fails is reported and the rest carries on. Without `gh` or `az` signed in, the list says the pull requests couldn't be asked about, and a squash-merged branch whose remote branch was deleted isn't caught, since its commits are on neither a remote branch nor the default branch: delete it yourself (`d`). Only the last 200 merged pull requests are looked at. Fetch first (`f`) so Splice knows which remote branches are gone.

### Repositories

The Repos view (`7`) lists the repositories you've opened and the ones found in the folders you scan (`s`, or `/scan <folder>`), each with its branch, how far it is ahead (`↑`) of and behind (`↓`) its upstream, and how many changed files it has (`●`; `✓` when there's nothing to say). `F` fetches them all, four at a time, with the count so far in the panel's title and `fetching…` on the rows under way; then each row shows where it stands against what's on its remotes now. A repository that can't be fetched (its remote is gone, or it needs a sign-in Splice can't ask for) says why on its row, and the rest carry on. Esc stops it; what's fetched by then stays fetched.

### Running git directly

`!log --stat -5`, `!remote -v`, `!clean -n`: anything after `!` runs as a git command in the open repository. Short output appears in the activity lines; longer output opens in the viewer. Commands that need a terminal of their own (`add -p`, `rebase -i`, anything that opens an editor) won't work here, because git runs without one.

## How it behaves

- **Safe by default.** Discarding, force-deleting a branch, deleting a remote branch, dropping a stash, rebasing, resetting and force-pushing all ask first. `/push --force` uses `--force-with-lease`. Deleting a branch tries `git branch -d` first and only offers `-D` when git says the branch isn't merged. `/cleanup` lists everything it would delete before asking.
- **`z` undoes the last thing you did**, after saying what it will do. A commit or amend comes undone with its changes back in staged; a merge, rebase, pull, reset, cherry-pick or revert moves the branch back to where it was (with `git reset --keep`, which stops rather than overwrite uncommitted changes); a switch switches back. It works this out from the reflog, using the branch's own so a whole rebase is one step. If what it would undo is already pushed, it says so: undoing it here doesn't undo the push. Pressing `z` again redoes. During a merge or rebase stopped on conflicts, use `/abort` instead.
- **Discards can be undone too.** Before discarding a file, some lines or everything (`/discard`), Splice keeps a copy of what goes in `.git/splice-undo/`, untracked files included, and `z` puts it back (the last ten discards are kept). The one exception is an untracked folder that's a repository of its own, which is deleted for good. `/reflog` lists everywhere HEAD has been, to look at, reset to or check out.
- **First push sets the upstream** (`push -u origin <branch>`), so `P` works on a new branch.
- **Committing with nothing staged** offers to stage everything first.
- **Stashing and restoring single files.** In Changes, `s` stashes just the file under the cursor, staged and unstaged changes together, with its path as the stash's message (a conflicted file can't be stashed, nor a staged rename or deletion until you unstage it). To stash several files together, `v` on the first, move to the last, and `s`. In a file's diff, `s` stashes just the hunk under the cursor, or the lines selected with `v`: they leave the file, the rest stays, and applying or popping the stash brings back just those lines. (Where git won't apply a stash because the files it touches have other uncommitted changes, Splice puts the stash's changes on top of them as a patch instead.) Stashing everything (`s` in Stash, `/stash`) takes untracked files too, unless **Stash untracked files** is off in `/settings`; `/stash -u` or `/stash --no-untracked` says otherwise for one stash. In Stash, `F` lists the stash's files, untracked ones included, and `↵` puts one back the way `git stash apply` would: a change unstaged, a file the stash added staged, an untracked file untracked. For a file the stash deleted, it offers to delete it. If the file has uncommitted changes, it asks before overwriting them.
- **Diffs pick out the words that changed** within a line, in a darker shade of its red or green, wherever a diff is shown. A removed line and the added line that replaced it are compared word by word; a line rewritten from scratch isn't, as highlighting all of it would say nothing.
- **Diffs side by side.** `w` on a diff, in the viewer or in Changes, shows the file as it was on the left and as it is on the right, each line with its number, and `w` again goes back to one column. Unchanged lines show on both sides; a run of removed lines faces the added lines that replaced it, one for one, and what's left over faces a blank, as on GitHub. Headers, and review comments under the lines they're about, go across both columns. Search, `n`/`N` and the line cursor in a pull request's diff work the same; there `h`/`l` move the cursor to the old or the new side of its row, and `c` on an unchanged line comments on it as it is on that side. It needs room: a window at least 120 columns wide for the viewer, and 156 for Changes, whose file list narrows to make space (down to 36 columns); in a narrower one diffs show in one column, and `w` says how wide it has to be. Splice remembers the choice for every diff after (the **Side-by-side diffs** setting).
- **Submodules** are listed at the bottom of Changes with their state: not initialised, out of date (it has another commit checked out than the one recorded here), with changes of its own inside, or up to date. `I` initialises one and checks out the recorded commit (`git submodule update --init --recursive`; `/submodule-update` does them all), asking first when that moves it off a commit it has checked out. `o` opens it in Splice as the repository it is. A submodule whose commit moved also shows as a changed file, to stage and commit like any other.
- **Partial staging** builds a patch of just the picked lines and applies it to the index (`git apply --cached`); unstaging and discarding apply it in reverse. Part of a brand-new file works too: the file is first recorded with `git add --intent-to-add`.
- **Merges, rebases, cherry-picks and reverts that stop on conflicts** show a banner in the header. Resolve files in Changes, then `/continue`, or `/abort`. `↵` on a conflicted file shows its conflict blocks, ours and theirs (and the base, in diff3 style), with a few lines around each; `o`, `t` or `b` takes ours, theirs or both for the block under the cursor, rewriting the file with its own line endings, and leaving it unstaged until `space` marks it resolved. `O`/`T` take a side for the whole file and mark it resolved in one go.
- **Long commands say when they're done.** When something with the spinner (a fetch, a push, a rebase, an answer from Claude) takes longer than 10 seconds, Splice rings the terminal's bell and asks it for a desktop notification saying what finished and how (OSC 9, which Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE terminals), for when you've switched to another window. A command you cancel says nothing. While the PRs or Branches view is open, the pull request list's poll does the same when the checks of one of your own pull requests have all finished (passed or failed; on GitHub and GitLab, as Azure DevOps lists no checks) and when someone reviews one (on Azure DevOps, a vote). **Notify when done** in `/settings` turns it all off, and `"notifyAfter"` in the settings file changes the seconds.
- **Outside changes show up on their own.** While open, Splice checks the repository every 3 seconds and reloads when the status or any ref changes.
- **The window title shows the repository and branch**, like `splice (main) — Splice`, so tabs running Splice are easy to tell apart. Quitting puts the terminal's own title back.
- **Never hangs on a prompt.** Git runs with `GIT_TERMINAL_PROMPT=0`; credentials come from your credential helper (Git Credential Manager on Windows). On Linux and macOS git also runs without a terminal of its own, so ssh, ssh-keygen or a pinentry that would ask in the terminal fails at once instead. Esc cancels a slow fetch or push.
- **Signed commits.** With `commit.gpgsign` on, Splice's commits are signed as git's own are, and the activity line says "Signing and committing". The commit pane in the graph says whether each commit is signed, and whether the signature is good (`%G?`). Since there's no terminal to type a passphrase in, a key has to be ready to use: unlocked in gpg-agent, added to ssh-agent, or with a pinentry that opens its own window (as on Windows and macOS). On Linux without a desktop, Splice checks a gpg key before committing; either way, a commit that can't be signed stops with a message saying so and what to do, rather than waiting.
- In the graph, `●` is a commit, `○` a merge, and `◌` your uncommitted changes, above the commit you have out. The default branch is always the left-most column, one straight line. Every other branch has a column and a colour of its own from its tip down to the commit it started from (branches that never overlap share a column), and a merge's line to the branch it brings in leaves from its own row, with an arrow (`<` or `>`) pointing into the merge. A row with no commit follows each merge, and a branch bends back into the commit it started from on a row of its own, which gives each branch some room. The graph loads 400 commits at a time and fetches more as you scroll to the bottom. `/find` filters the loaded commits by message, author, hash or branch name. `/find -S <text>` searches the whole history instead, every branch included, for the commits that add or remove the text, and `/find -G <regex>` for the ones whose added or removed lines match the regex; esc cancels a slow search. `/filter` narrows the graph to the commits on any branch by an author (`--author ana`, name or email, any case), touching a file or folder (`--path src/ui`, relative to the repository's root), or in a date range (`--since 2026-01-01`, `--until "2 weeks ago"`, anything git understands); combine them freely, and quote values with spaces. Either way the graph shows just the matching commits, `↵` opens one's diff, and esc (or `/filter` alone) goes back to the full graph.

## Meet Twig

Twig is Splice's beaver: the logo, the app icon, and the face in the top-left corner. Beavers spend their lives joining branches together, which is more or less what a merge is for. The `Π` in Twig's face is the two front teeth.

Twig keeps an eye on the repository. They're asleep `(–Π–)` when everything is committed, awake `(•Π•)` when there are changes, waving `(•Π•)/` when you have commits to push, glancing around while git works, pleased `(^Π^)` for a few seconds after something succeeds, and alarmed `(◉Π◉)` on conflicts or an error. When Splice starts (in a terminal at least 28 rows tall), Twig greets you in a welcome box like Claude Code's; esc or your first command puts it away.

The app icon at every size it ships in, drawn by `scripts/logo.js` like the rest: `logo.ico` on top (the executable's icon), `logo-transparent.ico` below.

<p align="center"><img src="assets/logo-icons.png" alt="Twig as an icon at 16, 24, 32, 48, 64, 128 and 256 pixels, on the dark square and on transparency"></p>

## Settings

`,` (or `/settings`) lists every setting with its value, and `↵` changes the one under the cursor; each change is saved as you make it:

- **Accent colour**: `↵` puts `/accent <colour>` in the prompt; give `#rrggbb`, or `default`. It repaints straight away.
- **Mouse**: on or off. Off, Splice leaves clicks and selecting to the terminal.
- **Stash untracked files**: on (the default), stashing everything takes new files too; off, only changes to tracked files (`/stash -u` still takes them).
- **Notify when done**: on (the default), a command that takes longer than 10 seconds rings the terminal's bell and raises a desktop notification when it ends, and so does news on your own pull requests (see [How it behaves](#how-it-behaves)); off, it says nothing. `"notifyAfter": 30` in the settings file changes the seconds.
- **Side-by-side diffs**: off (the default), diffs show in one column; on, old and new side by side wherever the window is wide enough. `w` on a diff changes it too (see [How it behaves](#how-it-behaves)).
- **Check for new versions** and **Install them by itself**: on or off (see [Updates](#updates)).
- **Folders to scan**: the list `/scan` adds to; `x` removes one, `s` adds one.
- **Recent repositories** and **Prompt history**: `↵` clears them, after asking. Forgetting a repository only takes it off the list.
- **Settings file**: where it all lives, `~/.splice/config.json` (or under `SPLICE_HOME`), if you'd rather edit it by hand. Only there: `"hosts"`, which says which servers are GitLab when their name doesn't (`{ "git.example.com": "gitlab" }`; see [Pull requests](#pull-requests)). `/ship` keeps its own there too: `"shipMethods"`, how each repository merges, and `"shipped"`, the branches it's watching.

### Updates

The downloaded Splice keeps itself up to date. Once a day at most, after it opens, it asks GitHub for the latest release, and if it's newer than yours, downloads it in the background and puts it in place of the executable you ran; the new version starts the next time you open Splice. The activity lines and the welcome box say how far it got. `/update` does the same at once, whenever you like: it asks for the latest release however recently Splice last looked, and installs it even with the settings below turned off.

- It asks GitHub's public API first, then through [gh](https://cli.github.com) with your existing sign-in (needed while the repository is private), and downloads the same way.
- The download must match the checksum published with the release (`SHA256SUMS.txt`), or nothing is replaced.
- On Windows a running program can't be overwritten, only renamed, so the old executable is moved aside (`splice.exe.old.<time>`) and deleted on a later start.
- If Splice can't write to the folder it's in (installed under Program Files, say), or anything else goes wrong, nothing changes: it says a new version is out, and why it couldn't install it, with the download link.
- Offline or without gh, it says nothing and tries again next time. Running from a checkout skips all of this; `git pull` updates that.

The last answer is kept in the config as `lastUpdateCheck`. To only be told about new versions, or not to check at all, use `/settings`, or set them in the file:

```json
{ "autoUpdate": false }
{ "checkForUpdates": false }
```

## Development

```bash
npm test     # parser tests, plus end-to-end tests that drive the UI against a throwaway repo
npm start    # run from the checkout
```

The `.jsx` sources run directly: `src/register.js` installs a loader that compiles them with esbuild as they're imported, so there is no build step for development.

### Executables and releases

```bash
npm run build       # dist/ executable for this machine
npm run build:all   # every platform (Bun cross-compiles)
```

The executables are made with [Bun](https://bun.sh)'s `--compile` (fetched by npx, so nothing to install), which bundles the code and a runtime into one file of about 85 MB.

Releases are automatic: every push to main (a merged pull request, say) publishes a new GitHub Release. The Release workflow (`.github/workflows/release.yml`) picks the next version, the latest release with the patch number raised (v0.2.0 → v0.2.1), runs the tests, builds every platform and publishes it with the files and generated notes, creating the tag. For a new minor or major version, set it in `package.json` (`npm version minor --no-git-tag-version`) and merge that; a version higher than the latest release is used as is. Nothing is committed back, so `package.json` keeps the last version set by hand, while the executables carry the released one. Pushes that only change Markdown files don't release, and "Run workflow" on the Release workflow in the Actions tab releases by hand. The Tests workflow runs the suite on Linux and Windows for every push to main and every pull request.

- `src/parse.js`: pure parsers for git's porcelain output. Most tests target these.
- `src/repo.js`: what's read from git for each view.
- `src/actions.js`: every git operation, written once; keys and slash commands both call these.
- `src/commands.js`: the slash command list and the completion logic.
- `src/ui/`: Ink (React for the terminal) components. `App.jsx` owns the layout, focus, the prompt and the `ctx` handle the actions use.
- `src/pet.js`: Twig's pixels and moods (and `PET`, the name and species the text uses). `node scripts/logo.js` redraws everything in `assets/` from them; rerun it after changing the drawing. `logo.svg`, `logo.png` and `logo.ico` sit on the dark rounded square; `logo-transparent.svg`, `logo-transparent.png` (512 × 384) and `logo-transparent@4x.png` (2048 × 1536) are just the beaver, cropped (with room for the badge), on transparency, and `logo-transparent.ico` is the beaver centred on a transparent square (16 to 256 px). `logo-icons.png` shows every size in both `.ico` files, scaled up with whole pixels, for this README. Each one carries the Git logo as a pixel-art badge in the bottom-right corner, so the icon reads as a git tool at a glance. Like Trawl's Glim and Keel's Pinch, Twig is coloured from the accent: the green for the outline, a darker and a paler shade for the fur and muzzle, and one warm colour, the orange of the teeth (a beaver's really are orange).
