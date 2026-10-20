# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Tiller is a keyboard-driven git client for the terminal, built with Ink (React for the terminal) on Node 22+. Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config.

## Commands

```bash
npm test                                                       # whole suite (node:test)
node --import ./src/register.js --test test/parse.test.js      # one file
node --import ./src/register.js --test --test-name-pattern="rebase" test/*.test.js   # tests matching a name
npm start                                                      # run from the checkout (needs a real TTY)
node bin/tiller.js C:\some\repo                                # open a specific repo
npm run build                                                  # Bun-compiled executable for this machine → dist/
npm run build:all                                              # every release target
node scripts/logo.js                                           # regenerate assets/ from src/knot.js
```

`bin/tiller.js` sets `NODE_ENV=production` only while it imports React and Ink, which picks React's production build (several times faster to render), then removes it so git hooks don't inherit it. The compiled builds define it in the bundle instead. Tests run React's development build.

`--import ./src/register.js` is required whenever Node loads `.jsx`: it installs a module hook (`src/jsx-hooks.js`) that compiles `.jsx` with esbuild on import. There is no dev build step. CI runs `npm test` on Linux and Windows, so path handling and line endings must work on both (`.gitattributes` forces LF).

Releases are automatic: every push to main (except Markdown-only ones) runs the Release workflow, which publishes the latest release's version with the patch raised, or `package.json`'s version when that's higher (bump it there for minor or major). It sets the version in the runner before building and commits nothing back, so `package.json` on main lags behind the releases. Compiled builds get the version via `process.env.TILLER_VERSION` (defined by `scripts/build.js`), which also sets `COMPILED`; from a checkout `src/version.js` reads `package.json`, and the update check is skipped.

## Architecture

The layering, bottom to top:

- **`src/git.js`**: the only way git is spawned. Forces `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_EDITOR=true`, `core.quotepath=false`, `color.ui=false`. Git runs with no terminal, so nothing may ever wait on a prompt or an editor. Failures throw `GitError` carrying git's own stderr; aborts set `cancelled`.
- **`src/parse.js`**: pure parsers for porcelain/log/ref output plus the format strings they expect (`LOG_FORMAT`, `REF_FORMAT`, ...). Keep parsing here and pure; most unit tests target it. Same for `src/patch.js` (diff parsing and building partial-staging patches for `git apply --cached`) and the pure parts of `src/rebase.js` and `src/hosting.js`.
- **`src/repo.js`**: reads everything a view needs into one `data` object (status, changes, graph, refs, stash, worktrees, remotes, in-progress `state`, a `signature` for change detection). Starting git costs about 100 ms on Windows, so loads keep the number of git processes low: one ref listing serves both the views and the signature, and the stash list and remotes are reused until their file in the common dir changes. `loadRepo().signature` must equal `snapshot().signature` byte for byte when nothing changed, or every poll reloads; `test/repo.test.js` checks this.
- **`src/actions.js`**: every user-facing git operation, written once. Both key handlers and slash commands call these with `ctx`. Confirmation prompts for destructive operations live here (`ctx.confirm({..., danger: true})`).
- **`src/commands.js`**: the slash-command table (`name`, `args`, `desc`, optional `complete: 'refs' | 'repos'`, `run(ctx, rest)`) and completion. Args in `[brackets]` are optional, so selecting the command runs it immediately.
- **`src/ui/App.jsx`**: owns layout, focus, the prompt, overlays, the activity log, the 3-second poll that reloads when `snapshot().signature` changes, and builds **`ctx`**: a stable object (kept in a ref) exposing `data` (getter), `exec`, `git`, `note`, `confirm`, `prefill`, `reload`, `host()`, `show*` overlays, etc. Read the `Object.assign(ctx, {...})` block in `App.jsx` before adding an action. `ctx.exec` runs a visible, cancellable git command and reloads afterwards; `ctx.git` is a silent read.
- **`src/ui/*View.jsx`**: one component per tab. Views must check `ctx.viewHasKeys()` (or `ctx.overlayHasKeys()` in overlays) at the start of their `useInput` handlers so keys don't fire while the prompt, an overlay or a confirm has focus. `useListNav` in `src/ui/hooks.js` is the shared cursor/scroll logic.

Cross-cutting pieces:

- **Pull requests** (`src/hosting.js`): `hostFor(data)` picks GitHub (via `gh`) or Azure DevOps (via `az` + `azure-devops` extension) from the remote URL. Tiller never handles tokens; it shells out to those CLIs. Server JSON is normalised into one PR shape (`githubPr`, `azurePr`). Azure PR diffs are computed locally after fetching both branches.
- **Interactive rebase** (`src/rebase.js`): no editor. Tiller writes the todo itself under `.git/tiller-rebase/` and passes it through `GIT_SEQUENCE_EDITOR`; reword becomes `pick` + `exec git commit --amend -F <file>`.
- **Claude** (`src/claude.js`, actions `describeCommit`, `draftPr`, `claudeLook`, `claudeRef`): runs `claude -p` with the user's sign-in, the input (a diff) on stdin. The flags skip MCP servers, settings files and skills, which cuts a call from ~15 s to ~7 s. Writing messages gets no tools; explaining and reviewing get read-only `Read`, `Grep`, `Glob`. `cli.jsx` passes `ask` to `App` as `askClaude`, exposed as `ctx.askClaude`; tests pass a stub, so they never call the real CLI. Prompts and answer parsing are pure functions in `claude.js`.
- **Updates** (`src/update.js`): once a day, GitHub's public releases API, then `gh api` as a fallback (the repo is private). A newer release is then installed in the background (`installUpdate`: download next to the executable, check `SHA256SUMS.txt`, swap by renaming; on Windows the running exe is renamed aside and `removeOldExecutables` deletes it on a later start). Release file names must match `TARGETS` in `scripts/build.js`. `cli.jsx` passes both to `App` as the `checkUpdate` and `installUpdate` props, only in compiled builds; tests leave them out or pass stubs, so they never go online or replace anything. The last answer is saved in the config through `App`'s `setConfig`. Don't write the config file from anywhere else: `App` saves its whole copy and would overwrite it.
- **Config** (`src/config.js`): `~/.tiller/config.json`, overridable with `TILLER_HOME` (tests use this). Compare paths with `samePath` (case-insensitive on Windows).
- **Theme** (`src/theme.js`): single palette; `accent` is user-configurable. Use `BULLET` instead of `⏺` directly (Windows renders it as a wide emoji). Use `src/text.js` (`fit`, `wrap`, `stringWidth`) for width-aware truncation, never `.length`.
- **Knot** (`src/knot.js`, `src/ui/Knot.jsx`): the otter mascot's pixel art and mood-from-repo-state logic. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files.

## Tests

`test/app.test.js` is end-to-end: it builds a throwaway repo in a temp dir, renders `<App>` with `ink-testing-library`, types keys into stdin and asserts on both `lastFrame()` and the real git state. Use its `until(check, what)` helper to wait for frames rather than fixed sleeps. Other test files are plain unit tests of the pure modules.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` overlay text in `src/help.js`, and the tables in `README.md`. README prose describes behaviour in plain, user-facing language. Commit messages are short sentences describing the change, without type prefixes.
