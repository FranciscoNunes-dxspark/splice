<p align="center"><img src="assets/logo.svg" width="128" alt="Twig, the Splice beaver"></p>

# Splice

A keyboard-driven git client for the terminal, with an interface modelled on Claude Code: titled rounded panels, a prompt box with slash commands and completion, `!` to run any git command, and a running log of what each command did.

Splice used to be called Tiller. A Tiller that updates itself becomes Splice on its own (the executable keeps its old file name until you rename it), and your recent repositories and settings in `~/.tiller` carry over.

```
(•Π•) Splice  │  Keel  ⎇ main → origin/main ↑1  ● 2 changes                              C:\Team\Keel
 1 Graph   2 Changes 2   3 Branches   4 Worktrees   5 Stash   6 PRs   7 Repos
╭─ Commits ────────────────────────────────── 125 ─╮╭─ Commit ──────────────── J/K scroll ─╮
│❯ ◌  // WIP  2 changed files                      ││4e9f0080cb  19/10/2026, 15:14:35      │
│  ●    ● main ⇅ origin  Compact view on the Pro…  ││Francisco Nunes                       │
│  ●   Merge pull request #27 from …               ││                                      │
│  │\                                              ││Compact view on the Production page   │
│  ● │ Add CLAUDE.md for Claude Code               ││                                      │
│  │ ●  origin/ccr-618ea99b  Don't show an old …   ││6 files changed                       │
│  │/                                              ││M README.md                           │
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

Press `?` inside for every shortcut. The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`7` or `tab` switch views · `/` commands · `!` any git command · `f` fetch · `p` pull · `P` push · `r` refresh · `z` undo the last commit, merge, rebase, reset, switch or discard · `,` settings · `esc` cancel the running command · `q` quit |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page · `J`/`K` scroll the right-hand pane · `y` copy what's under the cursor: a commit's hash, a branch name, a file's path, a stash's message, a PR's link |
| Graph | `↵` full diff · `c` check out · `b` branch here · `t` tag here · `m` merge · `i` interactive rebase from here · `C` cherry-pick · `v` revert · `X` reset to here · `B` bisect: mark it bad or good · `e` / `R` Claude explains / reviews it |
| Rebase editor | `p` pick · `r` reword · `e` edit · `s` squash · `f` fix up · `d` drop · `J`/`K` move · `↵` start · `esc` cancel |
| Changes | `space` stage/unstage · `↵` step into the diff · `a` stage all · `u` unstage all · `d` discard · `s` stash just this file · `c` commit · `A` amend · `F` fix up an earlier commit · `H` the file's history · `B` blame · `W` Claude writes the message · `R` Claude reviews · on conflicts `↵` resolve block by block, `O` ours / `T` theirs for the whole file, `C` Claude proposes a resolution |
| File history | `↵` the commit's diff of the file · `B` blame as of that commit · `esc` close |
| Blame | `↵` diff of the commit behind the line · `H` the file's history · `v` select lines, then `L` every commit that changed them · `esc` close |
| Changes, in the diff | `j`/`k` changed lines · `n`/`N` hunks · `space` stage (or unstage) the hunk · `v` select lines, then `space` stages just those · `d` discard them · `esc` back |
| Changes, in a conflict | `j`/`k` or `n`/`N` conflict blocks · `o` take ours · `t` take theirs · `b` keep both · `esc` back |
| Branches | `↵` check out (remote branches get a tracking branch) · `n` new from here · `m` merge · `e` rebase onto · `d` delete · `D` diff with the default branch · `o` open its pull request · `C` clean up |
| Worktrees | `↵` open · `n` new · `x` remove (or prune one whose folder is gone) · `C` clean up |
| Stash | `↵` diff · `s` stash · `S` stash with a message · `a` apply · `o` pop · `x` drop · `F` its files, to restore one (`↵`) or see its diff (`d`) |
| PRs | `↵` diff, with its review comments (`t`/`T` from one to the next, `r` reply) · `c` check out · `a` approve · `m` merge · `C` comment · `o` open in the browser · `n` new PR from the current branch · `W` Claude drafts one · `e` / `R` Claude explains / reviews it |
| Reflog (`/reflog`) | `↵` the commit's diff · `X` reset the current branch to it · `c` check it out |
| Repos | `↵` open · `s` add a folder to scan · `x` forget |
| Viewer (diffs, output, help, Claude's answers) | `j`/`k` scroll · `space` page · `n`/`N` next or previous hunk · `/` search: matches show as you type, `↵` keeps the search, then `n`/`N` go from match to match · `esc` clears the search, then closes |

The mouse works too: click a tab, a row or the prompt, double-click a row to do what `↵` does, and scroll the list or pane under the pointer with the wheel. In Changes, clicking a `+` or `-` line puts the cursor in the diff, ready to stage that hunk with `space`. Drag to select text as you would in the terminal: it's copied when you let go (through the terminal and the system clipboard), and stays highlighted until the next key or click. With the mouse turned off in the settings, the terminal does its own selecting again. On Windows the downloaded Splice handles the mouse itself; run from a checkout, it needs Node 22.17 or later.

### Slash commands

Type `/` and the menu narrows as you type; `tab` completes, `↑`/`↓` picks, `↵` runs. Commands that take a branch complete branch, tag and remote names; `/history` and `/blame` complete the repository's tracked files.

`/commit <msg>` `/amend [msg]` `/checkout <ref>` `/branch <name> [start]` `/delete <ref>` `/merge <ref>` `/rebase <ref>` `/reset <ref>` `/tag <name> [ref]` `/fetch` `/pull [--rebase]` `/push [--force]` `/stash [msg]` `/pop` `/discard` `/undo` `/reflog` `/continue` `/abort` `/find <text>` `/find -S <text>` `/find -G <regex>` `/fixup [ref]` `/open <path>` `/scan <folder>` `/last` `/settings` `/accent <#rrggbb|default>` `/refresh` `/help` `/quit` `/pr <title> [--into <branch>] [--draft]` `/comment <text>` `/approve` `/merge-pr [squash|merge|rebase] [--delete-branch] [--auto]` `/worktree <path> [ref]` `/compare <ref> [base]` `/history <path>` `/blame <path>` `/cleanup` `/describe` `/draft-pr [--into <branch>]` `/explain [ref]` `/review [ref]`

### Branches

The Branches view (`3`) compares each branch with the default branch: the remote's own default (`origin/HEAD`), or else `main` or `master`. The right-hand pane shows how far the selected branch is ahead and behind, the commits it has that the default branch doesn't, then its earlier history. `D` opens the full diff of what the branch adds, as a pull request would show it; `/compare <ref> [base]` does the same for any ref, against any base. Branches with an open pull request show its number (`#12` on GitHub, `!12` on Azure DevOps), coloured by its review state (green approved, red changes requested, yellow waiting), and its checks; `o` opens it in the browser.

### Interactive rebase

On a commit in the graph, `i` opens the commits from that one up to HEAD, newest on top. Mark each as pick, reword, edit, squash, fix up or drop, move them with `J`/`K`, and press `↵`. Squash and fix up fold a commit into the one drawn below it. Reword asks for the new message in the prompt (`/reword <message>`). `/rebase -i <ref>` does the same for the commits after `<ref>`.

Before it starts, Splice says how many commits it will rewrite and warns if any are already pushed (you'd need `/push --force` afterwards). It refuses while you have uncommitted changes, and on ranges with merge commits, which a rebase would flatten. No editor ever opens: Splice writes git's todo list itself, and rewords by amending from a file. If it stops on a conflict or an `edit`, fix things up and `/continue`, or `/abort` to put the branch back.

**Fixups.** To fix an earlier commit, stage the fix and press `F` in Changes (or `/fixup [ref]`). Pick the commit from the list of the branch's commits that aren't on its upstream or the default branch yet (or the latest 30, if there are none). Splice commits the fix as `fixup! <subject>` and asks whether to fold it in now: yes runs an autosquash rebase from that commit's parent, setting your other uncommitted changes aside meanwhile (`--autostash`); no keeps the fixup! commit for later. It warns when the commit is already pushed, and won't fold across merge commits. With nothing staged, it offers to stage everything first.

### Finding the commit that broke something

`B` on a commit in the graph starts a bisect: say whether that commit is bad (it has the problem) or good (from before it), then do the same on one of the other kind. Git checks out a commit halfway between, and the cursor goes to it: try it, then `B` again to mark it bad, good, or skipped if you can't tell (it doesn't build, say). Each answer halves what's left, so a few steps name the first bad commit. Marked commits carry `bad` and `good` labels in the graph, and the header says BISECTING until `/abort` (or `/bisect reset`) puts you back where you started. `/bisect good|bad|skip [ref]` does the same from the prompt.

### File history and blame

On a file in Changes, `H` lists the commits that touched it, newest first, following it through renames: each with its hash, age, author and subject, plus the name the file had then if it was different. `↵` shows that commit's changes to the file, and `esc` brings the list back. `/history <path>` does the same for any file, including one that has since been deleted. Paths are relative to the repository's root, and the prompt completes them.

`B` (or `/blame <path>`) shows the file line by line, with who last changed each line, in which commit and when, written once at the top of each run of lines from the same commit. It blames the file as it is on disk, so lines you haven't committed yet say so. `↵` on a line shows the commit that last changed it, and `H` switches to the file's history. From the history, `B` blames the file as it was in the selected commit.

To see how a few lines came to be, put the cursor on the first in blame, press `v`, move to the last, and press `L` (or just `L` for the line under the cursor). Every commit that changed them is listed with what it did to those lines, newest first (`git log -L`), following them as other lines move around them. Lines you've changed but not committed are matched to where they were in the last commit; ones you've only just written have no history yet.

### Pull requests

The PRs view (`6`) lists the open pull requests of the repository's remote, on **GitHub** or **Azure DevOps** (`dev.azure.com` and `*.visualstudio.com`). Ones asking for your review come first (◆), then yours (●). The right-hand pane shows reviewers and their votes, checks (GitHub checks, Azure DevOps branch policies), the description and comments, with their Markdown formatted (headings, bold, lists, code, links, tables). The list refreshes every minute while you're on it, and on `r`.

Splice talks to the servers through their own CLIs, using the sign-in you already have, so it never sees or stores a token:

- GitHub: [gh](https://cli.github.com), signed in with `gh auth login`.
- Azure DevOps: [az](https://aka.ms/installazurecliwindows) with the `azure-devops` extension (`az extension add --name azure-devops`), signed in with `az login`.

**Review comments in the diff.** `↵` on a pull request shows its diff with the reviewers' comments drawn under the lines they're about, each thread in a box with its replies, Markdown formatted. `t` and `T` go from one thread to the next, and `r` replies to the one picked (or the first on screen): the prompt fills with `/reply `, and the reply shows in the thread once it's posted. Comments on lines the diff no longer shows (the code changed since) are listed at the top. Azure DevOps marks fixed and closed threads as resolved; GitHub's API doesn't say, so its threads show without that.

`/pr <title>` opens a pull request from the current branch into the repository's default branch (or `--into <branch>`), pushing the branch first if the server doesn't have your latest commits. Approving and opening a PR ask first; `/comment` posts as soon as you press enter.

**Merging.** `m` (or `/merge-pr`) merges the pull request on the server. Splice asks how (squash, a merge commit, or rebase; Azure DevOps offers squash or a merge commit), then when: now, or once its required checks and reviews pass (GitHub's auto-merge, Azure DevOps' auto-complete), and whether to delete the source branch on the server afterwards. `/merge-pr squash --delete-branch --auto` says it all at once and only asks to confirm. Your local copy of the branch is left alone; `f` fetches the merge. Azure DevOps PR diffs are made locally: Splice fetches both branches and shows what the source branch adds. Listing Azure DevOps PRs takes a few seconds, most of it the az CLI starting up.

### Claude

With [Claude Code](https://claude.com/claude-code) installed and signed in, Splice can ask Claude to write and read changes for you. It runs `claude -p` with your existing sign-in, so Splice never sees a key. An answer takes several seconds, with the spinner showing; esc cancels.

- **Commit messages.** In Changes, `W` (or `/describe`) has Claude write the subject line for the staged changes, in the style of your recent commits. It lands in the prompt as `/commit …` for you to edit or just run.
- **Pull requests.** In PRs, `W` (or `/draft-pr [--into <branch>]`) has Claude draft a title and description from the branch's commits and diff. The draft opens in the viewer and the title goes in the prompt as `/pr …`; opening it asks whether to include the description.
- **Conflicts.** In Changes, `C` on a conflicted file has Claude propose the whole resolved file, from the file with its markers and the commit messages of both sides (it may read other files for context). The proposal opens as a diff against the file as it is; Splice asks before writing it, and leaves it unstaged for you to check and mark resolved.
- **Explain and review.** `e` explains and `R` reviews the commit under the cursor in the graph, or the pull request in PRs. In Changes (or on the working-tree row of the graph), `R` reviews your staged changes, or the unstaged ones if nothing is staged. `/explain [ref]` and `/review [ref]` do the same from the prompt. The answer opens in the viewer, its Markdown formatted.

Writing messages gives Claude no tools at all. Explaining, reviewing and resolving conflicts let it read files in the repository for context (`Read`, `Grep`, `Glob`), but never change them or run anything. Diffs over 200,000 characters are cut, and Claude is told where. To save time, Splice starts Claude without MCP servers, settings files or skills, so your hooks and permission rules don't apply to these calls (they can't change anything anyway).

### Worktrees

The Worktrees view (`4`) lists the main working tree and every worktree added to it, each with its branch, how far it is ahead of or behind its upstream, and how many changed files it has. ● marks the one open here. The right-hand pane shows the selected worktree's changes and recent commits, and `↵` switches Splice to it.

`/worktree <path> [ref]` runs `git worktree add` with git's own defaults: the path is relative to the repository's root, a branch that only exists on one remote gets a local tracking branch, and with no ref git makes a new branch named after the folder. Flags pass through, so `/worktree -b fix ../fix main` works too. `n` in the view starts one next to the repository, as `../<repo>-`. Removing (`x`) asks first and leaves the branch alone; if the worktree has uncommitted changes, it asks again before forcing. A worktree whose folder was deleted shows as missing, and `x` prunes it.

### Cleaning up

`/cleanup` (or `C` in Branches or Worktrees) clears away the branches and worktrees that have nothing of yours left on them. It lists what would go and why in the viewer, then asks: everything, only the branches, only the worktrees, or nothing.

- **Worktrees** go when they have no uncommitted changes (ignored files don't count), and ones whose folder is gone are pruned. Never the main working tree or the one open in Splice. A worktree on a branch with unpushed commits can still go; the branch stays, and the list says so.
- **Branches** go when none of their commits exist only here: they're merged into the default branch (the remote's `HEAD`, else what GitHub or Azure DevOps says, else `main` or `master`), or every commit is on a remote branch. That includes branches whose upstream was deleted after merging, and branches you pushed and haven't added to since (`↵` on the remote branch brings one back). Never the current branch, the default branch, or one checked out in a worktree that stays.

Worktrees are removed first with a plain `git worktree remove`, then branches deleted with `git branch -d`; `-D` is used only for branches it refuses because they aren't merged into the one you're on, which were already checked against the remotes and the default branch. Something that fails is reported and the rest carries on. A branch that was squash-merged and whose remote branch was then deleted isn't caught, since its commits are on neither: delete it yourself (`d`). Fetch first (`f`) so Splice knows which remote branches are gone.

### Running git directly

`!log --stat -5`, `!remote -v`, `!clean -n`: anything after `!` runs as a git command in the open repository. Short output appears in the activity lines; longer output opens in the viewer. Commands that need a terminal of their own (`add -p`, `rebase -i`, anything that opens an editor) won't work here, because git runs without one.

## How it behaves

- **Safe by default.** Discarding, force-deleting a branch, deleting a remote branch, dropping a stash, rebasing, resetting and force-pushing all ask first. `/push --force` uses `--force-with-lease`. Deleting a branch tries `git branch -d` first and only offers `-D` when git says the branch isn't merged. `/cleanup` lists everything it would delete before asking.
- **`z` undoes the last thing you did**, after saying what it will do. A commit or amend comes undone with its changes back in staged; a merge, rebase, pull, reset, cherry-pick or revert moves the branch back to where it was (with `git reset --keep`, which stops rather than overwrite uncommitted changes); a switch switches back. It works this out from the reflog, using the branch's own so a whole rebase is one step. If what it would undo is already pushed, it says so: undoing it here doesn't undo the push. Pressing `z` again redoes. During a merge or rebase stopped on conflicts, use `/abort` instead.
- **Discards can be undone too.** Before discarding a file, some lines or everything (`/discard`), Splice keeps a copy of what goes in `.git/splice-undo/`, untracked files included, and `z` puts it back (the last ten discards are kept). The one exception is an untracked folder that's a repository of its own, which is deleted for good. `/reflog` lists everywhere HEAD has been, to look at, reset to or check out.
- **First push sets the upstream** (`push -u origin <branch>`), so `P` works on a new branch.
- **Committing with nothing staged** offers to stage everything first.
- **Stashing and restoring single files.** In Changes, `s` stashes just the file under the cursor, staged and unstaged changes together, with its path as the stash's message (a conflicted file can't be stashed, nor a staged rename or deletion until you unstage it). In Stash, `F` lists the stash's files, untracked ones included, and `↵` puts one back the way `git stash apply` would: a change unstaged, a file the stash added staged, an untracked file untracked. For a file the stash deleted, it offers to delete it. If the file has uncommitted changes, it asks before overwriting them.
- **Diffs pick out the words that changed** within a line, in a darker shade of its red or green, wherever a diff is shown. A removed line and the added line that replaced it are compared word by word; a line rewritten from scratch isn't, as highlighting all of it would say nothing.
- **Partial staging** builds a patch of just the picked lines and applies it to the index (`git apply --cached`); unstaging and discarding apply it in reverse. Part of a brand-new file works too: the file is first recorded with `git add --intent-to-add`.
- **Merges, rebases, cherry-picks and reverts that stop on conflicts** show a banner in the header. Resolve files in Changes, then `/continue`, or `/abort`. `↵` on a conflicted file shows its conflict blocks, ours and theirs (and the base, in diff3 style), with a few lines around each; `o`, `t` or `b` takes ours, theirs or both for the block under the cursor, rewriting the file with its own line endings, and leaving it unstaged until `space` marks it resolved. `O`/`T` take a side for the whole file and mark it resolved in one go.
- **Outside changes show up on their own.** While open, Splice checks the repository every 3 seconds and reloads when the status or any ref changes.
- **The window title shows the repository and branch**, like `splice (main) — Splice`, so tabs running Splice are easy to tell apart. Quitting puts the terminal's own title back.
- **Never hangs on a prompt.** Git runs with `GIT_TERMINAL_PROMPT=0`; credentials come from your credential helper (Git Credential Manager on Windows). Esc cancels a slow fetch or push.
- The graph loads 400 commits at a time and fetches more as you scroll to the bottom. `/find` filters the loaded commits by message, author, hash or branch name. `/find -S <text>` searches the whole history instead, every branch included, for the commits that add or remove the text, and `/find -G <regex>` for the ones whose added or removed lines match the regex; esc cancels a slow search. Either way the graph shows just the matching commits, `↵` opens one's diff, and esc goes back to the full graph.

## Meet Twig

Twig is Splice's beaver: the logo, the app icon, and the face in the top-left corner. Beavers spend their lives joining branches together, which is more or less what a merge is for. The `Π` in Twig's face is the two front teeth.

Twig keeps an eye on the repository. They're asleep `(–Π–)` when everything is committed, awake `(•Π•)` when there are changes, waving `(•Π•)/` when you have commits to push, glancing around while git works, pleased `(^Π^)` for a few seconds after something succeeds, and alarmed `(◉Π◉)` on conflicts or an error. When Splice starts (in a terminal at least 28 rows tall), Twig greets you in a welcome box like Claude Code's; esc or your first command puts it away.

The app icon at every size it ships in, drawn by `scripts/logo.js` like the rest: `logo.ico` on top (the executable's icon), `logo-transparent.ico` below.

<p align="center"><img src="assets/logo-icons.png" alt="Twig as an icon at 16, 24, 32, 48, 64, 128 and 256 pixels, on the dark square and on transparency"></p>

## Settings

`,` (or `/settings`) lists every setting with its value, and `↵` changes the one under the cursor; each change is saved as you make it:

- **Accent colour**: `↵` puts `/accent <colour>` in the prompt; give `#rrggbb`, or `default`. It repaints straight away.
- **Mouse**: on or off. Off, Splice leaves clicks and selecting to the terminal.
- **Check for new versions** and **Install them by itself**: on or off (see [Updates](#updates)).
- **Folders to scan**: the list `/scan` adds to; `x` removes one, `s` adds one.
- **Recent repositories** and **Prompt history**: `↵` clears them, after asking. Forgetting a repository only takes it off the list.
- **Settings file**: where it all lives, `~/.splice/config.json` (or under `SPLICE_HOME`), if you'd rather edit it by hand.

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
