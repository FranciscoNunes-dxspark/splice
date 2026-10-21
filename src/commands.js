import * as a from './actions.js';
import { splitArgs } from './parse.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'commit', args: '<message> | --file [path]', desc: 'Commit the staged changes (\\n for a new line); --file: the message from a file, alone: written to one for your editor', run: (ctx, s) => a.commit(ctx, s) },
  { name: 'amend', args: '[message | --file [path]]', desc: 'Amend the last commit (keeps its message if none given); --file alone: its message in a file for your editor', run: (ctx, s) => a.commit(ctx, s, { amend: true }) },
  { name: 'fixup', args: '[ref]', desc: 'Make the staged changes a fix for an earlier commit (picked from a list), then fold it in', complete: 'refs', run: (ctx, s) => a.fixup(ctx, s) },
  { name: 'absorb', desc: "Each staged hunk becomes a fixup! for the branch's commit that last changed its lines (shows where, asks), then folds them in", run: (ctx) => a.absorb(ctx) },
  { name: 'checkout', args: '<branch|tag|hash>', desc: 'Switch to a branch, tag or commit', complete: 'refs', run: (ctx, s) => a.checkout(ctx, s) },
  { name: 'branch', args: '<name> [start]', desc: 'Create a branch and switch to it', run: (ctx, s) => a.createBranch(ctx, s) },
  { name: 'delete', args: '<branch|tag>', desc: 'Delete a branch (local or remote) or a tag', complete: 'refs', run: (ctx, s) => a.deleteRef(ctx, s) },
  { name: 'cleanup', desc: 'Delete branches and remove worktrees with nothing of yours on them, and merged PRs\' branches on the remote (asks first)', run: (ctx) => a.cleanUp(ctx) },
  { name: 'doctor', desc: 'A health check of the repository: what looks wrong, what to do about it, and doing what Splice can (asks first)', run: (ctx) => a.doctor(ctx) },
  { name: 'merge', args: '<ref>', desc: 'Merge a ref into the current branch', complete: 'refs', run: (ctx, s) => a.merge(ctx, s) },
  { name: 'cherry-pick', args: '<ref | a..b>', desc: 'Copy a commit onto the current branch, or the commits in a..b, oldest first (asks first)', complete: 'refs', run: (ctx, s) => a.cherryPickRefs(ctx, s) },
  { name: 'range-diff', args: '[branch | <a> <b>]', desc: "What the branch's last rebase, amend or reset changed in each commit (the current branch if none given); or compare two versions", complete: 'refs', run: (ctx, s) => a.rangeDiff(ctx, s) },
  { name: 'rebase', args: '[-i] <ref>', desc: 'Rebase the current branch onto a ref (-i: edit the commits after it)', complete: 'refs', run: (ctx, s) => a.rebase(ctx, s) },
  { name: 'forecast', args: '<ref> [base]', desc: 'Whether merging a branch with the default branch (or base) would conflict, and in which files (git merge-tree)', complete: 'refs', run: (ctx, s) => a.forecastConflicts(ctx, s) },
  { name: 'compare', args: '<ref> [base]', desc: 'Full diff of what a branch adds to the default branch (or to base)', complete: 'refs', run: (ctx, s) => a.compare(ctx, s) },
  { name: 'fetch', args: '[remote]', desc: 'Fetch all remotes and prune deleted branches', run: (ctx, s) => a.fetch(ctx, splitArgs(s)) },
  { name: 'sync', desc: 'Fetch, then fast-forward every local branch that is only behind its upstream; says which have diverged or lost theirs', run: (ctx) => a.sync(ctx) },
  { name: 'update-branch', args: '[base] [--stack]', desc: 'Rebase the current branch onto the latest default branch (or base); --stack moves the branches stacked with it too', complete: 'refs', run: (ctx, s) => a.updateBranch(ctx, s) },
  { name: 'pull', args: '[--rebase]', desc: 'Pull the current branch', run: (ctx, s) => a.pull(ctx, splitArgs(s)) },
  { name: 'push', args: '[--force] [remote]', desc: 'Push the current branch (sets the upstream the first time; asks first if its commits have big files or secrets); to another remote if named', run: (ctx, s) => a.push(ctx, splitArgs(s)) },
  { name: 'remote', args: '[add|rename|remove|set-url] [...]', desc: 'The remotes: list them, or add <name> <url>, rename <old> <new>, remove <name>, set-url <name> <url>', run: (ctx, s) => a.remote(ctx, s) },
  { name: 'upstream', args: '[branch] <remote/branch>', desc: 'Set the branch a local branch tracks (--unset to stop)', complete: 'refs', run: (ctx, s) => a.upstream(ctx, s) },
  { name: 'stash', args: '[-u | --no-untracked] [message]', desc: 'Stash all changes (untracked files too, unless set off in /settings), with an optional message', run: (ctx, s) => a.stash(ctx, s) },
  { name: 'submodule-update', args: '[path]', desc: 'Initialise and check out the recorded commit of every submodule, or one', run: (ctx, s) => a.updateSubmodules(ctx, s) },
  { name: 'ignore', args: '<pattern>', desc: "Add a pattern to the repository's .gitignore (i on an untracked file in Changes offers some)", run: (ctx, s) => a.ignore(ctx, s) },
  { name: 'discard', desc: 'Discard all uncommitted changes (asks first)', run: (ctx) => a.discardAll(ctx) },
  { name: 'undo', desc: 'Undo the last commit, amend, merge, rebase, reset, switch or discard (asks first)', run: (ctx) => a.undo(ctx) },
  { name: 'reflog', desc: 'Where HEAD has been: see, reset to or check out any earlier position', run: (ctx) => a.showReflog(ctx) },
  { name: 'pop', args: '[stash@{n}]', desc: 'Apply a stash and drop it', run: (ctx, s) => a.stashApply(ctx, s, { pop: true }) },
  { name: 'tag', args: '<name> [ref]', desc: 'Create a tag', run: (ctx, s) => a.tag(ctx, s) },
  { name: 'tag-push', args: '<tag> [remote]', desc: 'Push a tag (to origin unless a remote is named)', complete: 'refs', run: (ctx, s) => a.pushTag(ctx, s) },
  { name: 'release', args: '<tag> [--draft] [title]', desc: 'Create a GitHub or GitLab release for a tag, with notes written for you', complete: 'refs', run: (ctx, s) => a.createRelease(ctx, s) },
  { name: 'worktree', args: '<path> [ref]', desc: 'Add a worktree at a path (relative to the repository), checking out a ref', run: (ctx, s) => a.addWorktree(ctx, s) },
  { name: 'reset', args: '<ref>', desc: 'Move the current branch to a ref (soft, mixed or hard)', complete: 'refs', run: (ctx, s) => a.reset(ctx, s) },
  { name: 'pr', args: '<title> [--into <branch>] [--draft]', desc: 'Open a pull request from the current branch', run: (ctx, s) => a.createPr(ctx, s) },
  { name: 'comment', args: '<text>', desc: 'Comment on the pull request picked in PRs', run: (ctx, s) => a.prComment(ctx, s) },
  { name: 'reply', args: '<text>', desc: "Reply to a review comment in a pull request's diff (r on it)", run: (ctx, s) => a.replyToThread(ctx, s) },
  { name: 'review-comment', args: '<text>', desc: "Comment on the line under the cursor in a pull request's diff (c on it)", run: (ctx, s) => a.commentOnLine(ctx, s) },
  { name: 'resolve', desc: "Mark the review comment picked in a pull request's diff resolved (x on it)", run: (ctx) => a.resolveThread(ctx, true) },
  { name: 'unresolve', desc: "Open the review comment picked in a pull request's diff again (x on it)", run: (ctx) => a.resolveThread(ctx, false) },
  { name: 'merge-pr', args: '[squash|merge|rebase] [--delete-branch] [--auto]', desc: 'Merge the pull request picked in PRs (asks how; --auto once checks pass)', run: (ctx, s) => a.prMerge(ctx, ctx.selectedPr, s) },
  { name: 'ci', desc: 'CI checks of the pull request picked in PRs: logs, re-run the failed ones', run: (ctx) => a.prChecks(ctx, ctx.selectedPr) },
  { name: 'reviewer', args: '<name> [name ...]', desc: 'Ask people to review the pull request picked in PRs', run: (ctx, s) => a.prReviewers(ctx, s) },
  { name: 'draft', desc: 'Make the pull request picked in PRs a draft', run: (ctx) => a.prSetDraft(ctx, true) },
  { name: 'ready', desc: 'Mark the pull request picked in PRs ready for review', run: (ctx) => a.prSetDraft(ctx, false) },
  { name: 'title', args: '<text>', desc: 'Rename the pull request picked in PRs', run: (ctx, s) => a.prTitle(ctx, s) },
  { name: 'body', args: '[--file <path> | text]', desc: "Edit the picked pull request's description: alone, in a file for your editor", run: (ctx, s) => a.prBody(ctx, s) },
  { name: 'approve', desc: 'Approve the pull request picked in PRs', run: (ctx) => a.prApprove(ctx, ctx.selectedPr) },
  { name: 'request-changes', args: '[text]', desc: 'Ask for changes to the pull request picked in PRs (asks first; GitHub and GitLab need the text)', run: (ctx, s) => a.prRequestChanges(ctx, ctx.selectedPr, s) },
  { name: 'describe', desc: 'Claude writes the commit message for the staged changes', run: (ctx) => a.describeCommit(ctx) },
  { name: 'split', desc: 'Claude splits your uncommitted changes into logical commits, each reviewed before it is made', run: (ctx) => a.claudeSplit(ctx) },
  { name: 'draft-pr', args: '[--into <branch>]', desc: 'Claude drafts a pull request (title and description) for the current branch', run: (ctx, s) => a.draftPr(ctx, s) },
  { name: 'explain', args: '[ref]', desc: 'Claude explains a commit (HEAD if none given)', complete: 'refs', run: (ctx, s) => a.claudeRef(ctx, 'explain', s) },
  { name: 'review', args: '[ref]', desc: 'Claude reviews a commit, or your changes if none given', complete: 'refs', run: (ctx, s) => a.claudeRef(ctx, 'review', s) },
  {
    name: 'reword',
    args: '<message>',
    desc: 'New message for the commit picked in the rebase editor',
    run: (ctx, s) => (ctx.rebaseEditor ? (s ? ctx.rebaseEditor.reword(s) : ctx.note('Type the new message after /reword.', 'error')) : ctx.note('Open the rebase editor first: i on a commit in the graph.', 'error')),
  },
  {
    name: 'bisect',
    args: '<good|bad|skip|reset|run> [ref | command…]',
    desc: 'Find the commit that brought in a problem: mark commits good or bad (HEAD if no ref), run a command that tests each (exit 0 good, 125 skip, else bad), reset to stop',
    run: (ctx, s) => {
      const [how, ...rest] = splitArgs(s);
      return how === 'run' ? a.bisectRun(ctx, rest) : a.bisect(ctx, how, rest[0]);
    },
  },
  { name: 'continue', desc: 'Continue the merge, rebase, cherry-pick or revert', run: (ctx) => a.continueOp(ctx) },
  { name: 'abort', desc: 'Abort the merge, rebase, cherry-pick or revert', run: (ctx) => a.abortOp(ctx) },
  { name: 'history', args: '<path>', desc: "A file's commits, following renames (deleted files too)", complete: 'files', run: (ctx, s) => a.fileHistory(ctx, s) },
  { name: 'blame', args: '<path>', desc: 'Who last changed each line of a file', complete: 'files', run: (ctx, s) => a.blame(ctx, s) },
  {
    name: 'find',
    args: '<text>',
    desc: 'Filter the graph by message, author or hash; -S <text> or -G <regex> search all history for code changes',
    complete: 'flags',
    flags: [
      { flag: '-S', hint: '<text>', desc: 'Commits anywhere in history that add or remove the text' },
      { flag: '-G', hint: '<regex>', desc: 'Commits anywhere in history whose changed lines match the regex' },
    ],
    run: (ctx, s) => a.find(ctx, s),
  },
  {
    name: 'filter',
    args: '[--author <name>] [--path <path>] [--since <date>] [--until <date>]',
    desc: 'Show only the commits, on any branch, by an author, touching a path, or in a date range (alone: clear it)',
    complete: 'flags',
    flags: [
      { flag: '--author', hint: '<name>', desc: 'Commits whose author matches (name or email, any case)' },
      { flag: '--path', hint: '<path>', desc: 'Commits that touch a file or folder (relative to the repository)' },
      { flag: '--since', hint: '<date>', desc: 'Commits from this date on: 2026-01-31, "2 weeks ago", yesterday' },
      { flag: '--until', hint: '<date>', desc: 'Commits up to this date' },
    ],
    run: (ctx, s) => a.filter(ctx, s),
  },
  { name: 'open', args: '<path>', desc: 'Open a repository', complete: 'repos', run: (ctx, s) => (s ? ctx.openRepo(s) : ctx.prefill('/open ')) },
  { name: 'scan', args: '<folder>', desc: 'Add a folder to scan for repositories', run: (ctx, s) => ctx.addRoot(s) },
  { name: 'last', desc: 'Show the full output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Every setting, changed in place: accent colour, updates, folders, recent, history', run: (ctx) => a.settings(ctx) },
  { name: 'accent', args: '<#rrggbb|default>', desc: 'The accent colour, saved and repainted straight away', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'refresh', desc: 'Reload the repository', run: (ctx) => ctx.refresh() },
  { name: 'update', desc: 'Look for a new version of Splice now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keyboard shortcuts', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Splice', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

/** The kind of list (`complete`) offered for what's typed so far, while its first argument is being typed. */
export function completionKind(value) {
  const m = /^\/(\S+) (\S*)$/.exec(value);
  return (m && findCommand(m[1])?.complete) || null;
}

function completions(kind, data, repos, files) {
  if (kind === 'repos') return repos.map((r) => r.path);
  // Tracked files, relative to the repository root; App loads them when first asked for (see completionKind).
  if (kind === 'files') return files ?? [];
  if (!data) return [];
  const { local, remote, tags } = data.refs;
  return [...local.map((b) => b.name), ...remote.map((b) => b.name), ...tags.map((t) => t.name)];
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * What to offer under the prompt for `value`: commands while the name is being typed,
 * then refs, repos or files for commands that complete their argument.
 * `insert` replaces the prompt text; `run` means picking it can run straight away.
 */
export function suggestionsFor(value, { data, repos = [], files = [] }) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  if (space < 0) {
    const names = ranked(COMMANDS.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = COMMANDS.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space));
  const rest = value.slice(space + 1);
  if (!cmd?.complete || rest.includes(' ')) return [];
  // Flags the command takes before its text: offered until something else is typed.
  if (cmd.complete === 'flags') {
    return cmd.flags
      .filter((f) => f.flag.startsWith(rest) && f.flag !== rest)
      .map((f) => ({ label: f.flag, hint: f.hint, desc: f.desc, insert: `/${cmd.name} ${f.flag} ` }));
  }
  const names = ranked(completions(cmd.complete, data, repos, files), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
