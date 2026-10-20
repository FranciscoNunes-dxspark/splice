<p align="center"><img src="assets/knot.svg" width="128" alt="Knot, the Tiller otter"></p>

# Tiller

A keyboard-driven git client for the terminal, with an interface modelled on Claude Code: titled rounded panels, a prompt box with slash commands and completion, `!` to run any git command, and a running log of what each command did.

```
(•ω•) Tiller  │  Keel  ⎇ main → origin/main ↑1  ● 2 changes                              C:\Team\Keel
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

**Download** the executable for your platform from [Releases](https://github.com/FranciscoNunes-dxspark/tiller/releases): `tiller-windows-x64.exe`, `tiller-linux-x64` / `-arm64`, `tiller-macos-arm64` / `-x64`. It's a single file with nothing else to install; it only needs git on the PATH. Rename it to `tiller` (`tiller.exe`) and put it in a folder on your PATH. `SHA256SUMS.txt` lists each file's checksum.

The builds aren't code-signed, so Windows SmartScreen may ask before the first run ("More info" → "Run anyway"), and on macOS you may need `xattr -d com.apple.quarantine tiller-macos-arm64` once.

**From source** (Node 22+):

```bash
cd C:\Team\Tiller
npm install
npm link          # puts a `tiller` command on your PATH
```

Without `npm link`, run it with `node C:\Team\Tiller\bin\tiller.js`.

## Use

```bash
tiller              # the repository you're in
tiller C:\Team\Keel # a specific one
tiller C:\Team      # not a repository: lists the ones it finds inside
```

Press `?` inside for every shortcut. The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`7` or `tab` switch views · `/` commands · `!` any git command · `f` fetch · `p` pull · `P` push · `r` refresh · `esc` cancel the running command · `q` quit |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page · `J`/`K` scroll the right-hand pane |
| Graph | `↵` full diff · `c` check out · `b` branch here · `t` tag here · `m` merge · `i` interactive rebase from here · `C` cherry-pick · `v` revert · `X` reset to here · `e` / `R` Claude explains / reviews it |
| Rebase editor | `p` pick · `r` reword · `e` edit · `s` squash · `f` fix up · `d` drop · `J`/`K` move · `↵` start · `esc` cancel |
| Changes | `space` stage/unstage · `↵` step into the diff · `a` stage all · `u` unstage all · `d` discard · `c` commit · `A` amend · `W` Claude writes the message · `R` Claude reviews · on conflicts `↵` resolve block by block, `O` ours / `T` theirs for the whole file, `C` Claude proposes a resolution |
| Changes, in the diff | `j`/`k` changed lines · `n`/`N` hunks · `space` stage (or unstage) the hunk · `v` select lines, then `space` stages just those · `d` discard them · `esc` back |
| Changes, in a conflict | `j`/`k` or `n`/`N` conflict blocks · `o` take ours · `t` take theirs · `b` keep both · `esc` back |
| Branches | `↵` check out (remote branches get a tracking branch) · `n` new from here · `m` merge · `e` rebase onto · `d` delete |
| Worktrees | `↵` open · `n` new · `x` remove (or prune one whose folder is gone) |
| Stash | `↵` diff · `s` stash · `a` apply · `o` pop · `x` drop |
| PRs | `↵` diff · `c` check out · `a` approve · `C` comment · `o` open in the browser · `n` new PR from the current branch · `W` Claude drafts one · `e` / `R` Claude explains / reviews it |
| Repos | `↵` open · `s` add a folder to scan · `x` forget |

### Slash commands

Type `/` and the menu narrows as you type; `tab` completes, `↑`/`↓` picks, `↵` runs. Commands that take a branch complete branch, tag and remote names.

`/commit <msg>` `/amend [msg]` `/checkout <ref>` `/branch <name> [start]` `/delete <ref>` `/merge <ref>` `/rebase <ref>` `/reset <ref>` `/tag <name> [ref]` `/fetch` `/pull [--rebase]` `/push [--force]` `/stash [msg]` `/pop` `/discard` `/continue` `/abort` `/find <text>` `/open <path>` `/scan <folder>` `/last` `/refresh` `/help` `/quit` `/pr <title> [--into <branch>] [--draft]` `/comment <text>` `/approve` `/worktree <path> [ref]` `/describe` `/draft-pr [--into <branch>]` `/explain [ref]` `/review [ref]`

### Interactive rebase

On a commit in the graph, `i` opens the commits from that one up to HEAD, newest on top. Mark each as pick, reword, edit, squash, fix up or drop, move them with `J`/`K`, and press `↵`. Squash and fix up fold a commit into the one drawn below it. Reword asks for the new message in the prompt (`/reword <message>`). `/rebase -i <ref>` does the same for the commits after `<ref>`.

Before it starts, Tiller says how many commits it will rewrite and warns if any are already pushed (you'd need `/push --force` afterwards). It refuses while you have uncommitted changes, and on ranges with merge commits, which a rebase would flatten. No editor ever opens: Tiller writes git's todo list itself, and rewords by amending from a file. If it stops on a conflict or an `edit`, fix things up and `/continue`, or `/abort` to put the branch back.

### Pull requests

The PRs view (`6`) lists the open pull requests of the repository's remote, on **GitHub** or **Azure DevOps** (`dev.azure.com` and `*.visualstudio.com`). Ones asking for your review come first (◆), then yours (●). The right-hand pane shows reviewers and their votes, checks (GitHub checks, Azure DevOps branch policies), the description and comments, with their Markdown formatted (headings, bold, lists, code, links, tables). The list refreshes every minute while you're on it, and on `r`.

Tiller talks to the servers through their own CLIs, using the sign-in you already have, so it never sees or stores a token:

- GitHub: [gh](https://cli.github.com), signed in with `gh auth login`.
- Azure DevOps: [az](https://aka.ms/installazurecliwindows) with the `azure-devops` extension (`az extension add --name azure-devops`), signed in with `az login`.

`/pr <title>` opens a pull request from the current branch into the repository's default branch (or `--into <branch>`), pushing the branch first if the server doesn't have your latest commits. Approving and opening a PR ask first; `/comment` posts as soon as you press enter. Azure DevOps PR diffs are made locally: Tiller fetches both branches and shows what the source branch adds. Listing Azure DevOps PRs takes a few seconds, most of it the az CLI starting up.

### Claude

With [Claude Code](https://claude.com/claude-code) installed and signed in, Tiller can ask Claude to write and read changes for you. It runs `claude -p` with your existing sign-in, so Tiller never sees a key. An answer takes several seconds, with the spinner showing; esc cancels.

- **Commit messages.** In Changes, `W` (or `/describe`) has Claude write the subject line for the staged changes, in the style of your recent commits. It lands in the prompt as `/commit …` for you to edit or just run.
- **Pull requests.** In PRs, `W` (or `/draft-pr [--into <branch>]`) has Claude draft a title and description from the branch's commits and diff. The draft opens in the viewer and the title goes in the prompt as `/pr …`; opening it asks whether to include the description.
- **Conflicts.** In Changes, `C` on a conflicted file has Claude propose the whole resolved file, from the file with its markers and the commit messages of both sides (it may read other files for context). The proposal opens as a diff against the file as it is; Tiller asks before writing it, and leaves it unstaged for you to check and mark resolved.
- **Explain and review.** `e` explains and `R` reviews the commit under the cursor in the graph, or the pull request in PRs. In Changes (or on the working-tree row of the graph), `R` reviews your staged changes, or the unstaged ones if nothing is staged. `/explain [ref]` and `/review [ref]` do the same from the prompt. The answer opens in the viewer, its Markdown formatted.

Writing messages gives Claude no tools at all. Explaining, reviewing and resolving conflicts let it read files in the repository for context (`Read`, `Grep`, `Glob`), but never change them or run anything. Diffs over 200,000 characters are cut, and Claude is told where. To save time, Tiller starts Claude without MCP servers, settings files or skills, so your hooks and permission rules don't apply to these calls (they can't change anything anyway).

### Worktrees

The Worktrees view (`4`) lists the main working tree and every worktree added to it, each with its branch, how far it is ahead of or behind its upstream, and how many changed files it has. ● marks the one open here. The right-hand pane shows the selected worktree's changes and recent commits, and `↵` switches Tiller to it.

`/worktree <path> [ref]` runs `git worktree add` with git's own defaults: the path is relative to the repository's root, a branch that only exists on one remote gets a local tracking branch, and with no ref git makes a new branch named after the folder. Flags pass through, so `/worktree -b fix ../fix main` works too. `n` in the view starts one next to the repository, as `../<repo>-`. Removing (`x`) asks first and leaves the branch alone; if the worktree has uncommitted changes, it asks again before forcing. A worktree whose folder was deleted shows as missing, and `x` prunes it.

### Running git directly

`!log --stat -5`, `!remote -v`, `!clean -n`: anything after `!` runs as a git command in the open repository. Short output appears in the activity lines; longer output opens in the viewer. Commands that need a terminal of their own (`add -p`, `rebase -i`, anything that opens an editor) won't work here, because git runs without one.

## How it behaves

- **Safe by default.** Discarding, force-deleting a branch, deleting a remote branch, dropping a stash, rebasing, resetting and force-pushing all ask first. `/push --force` uses `--force-with-lease`. Deleting a branch tries `git branch -d` first and only offers `-D` when git says the branch isn't merged.
- **First push sets the upstream** (`push -u origin <branch>`), so `P` works on a new branch.
- **Committing with nothing staged** offers to stage everything first.
- **Partial staging** builds a patch of just the picked lines and applies it to the index (`git apply --cached`); unstaging and discarding apply it in reverse. Part of a brand-new file works too: the file is first recorded with `git add --intent-to-add`.
- **Merges, rebases, cherry-picks and reverts that stop on conflicts** show a banner in the header. Resolve files in Changes, then `/continue`, or `/abort`. `↵` on a conflicted file shows its conflict blocks, ours and theirs (and the base, in diff3 style), with a few lines around each; `o`, `t` or `b` takes ours, theirs or both for the block under the cursor, rewriting the file with its own line endings, and leaving it unstaged until `space` marks it resolved. `O`/`T` take a side for the whole file and mark it resolved in one go.
- **Outside changes show up on their own.** While open, Tiller checks the repository every 3 seconds and reloads when the status or any ref changes.
- **Never hangs on a prompt.** Git runs with `GIT_TERMINAL_PROMPT=0`; credentials come from your credential helper (Git Credential Manager on Windows). Esc cancels a slow fetch or push.
- The graph loads 400 commits at a time and fetches more as you scroll to the bottom. `/find` filters the loaded commits by message, author, hash or branch name.

## Meet Knot

Knot is Tiller's otter: the logo, the app icon, and the face in the top-left corner. Otters hold hands while they sleep so they don't drift apart, which is more or less what a merge is for.

Knot keeps an eye on the repository. They're asleep `(–ω–)` when everything is committed, awake `(•ω•)` when there are changes, waving `(•ω•)/` when you have commits to push, glancing around while git works, pleased `(^ω^)` for a few seconds after something succeeds, and alarmed `(◉ω◉)` on conflicts or an error. When Tiller starts (in a terminal at least 28 rows tall), Knot greets you in a welcome box like Claude Code's; esc or your first command puts it away.

## Settings

`~/.tiller/config.json` holds the recent repositories, the folders to scan, and the prompt history. You can also set the accent colour:

```json
{ "accent": "#5fd787" }
```

### Updates

Once a day at most, after it opens, the downloaded Tiller asks GitHub for the latest release, and if it's newer than yours, says so in the activity lines and the welcome box. It asks GitHub's public API first, then through [gh](https://cli.github.com) with your existing sign-in (needed while the repository is private). If neither works (offline, no gh), it says nothing and tries again next time. Running from a checkout skips the check; `git pull` updates that. The answer is kept in the config as `lastUpdateCheck`. To turn the check off:

```json
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
- `src/knot.js`: Knot's pixels and moods. `node scripts/logo.js` redraws everything in `assets/` from them; rerun it after changing the drawing. `knot.svg`, `knot.png` and `knot.ico` sit on the dark rounded square; `knot-transparent.svg`, `knot-transparent.png` (512 × 384) and `knot-transparent@4x.png` (2048 × 1536) are just the otter, cropped (with room for the badge), on transparency, and `knot-transparent.ico` is the otter centred on a transparent square (16 to 256 px). Each one carries the Git logo as a pixel-art badge in the bottom-right corner, so the icon reads as a git tool at a glance.
