import * as a from './actions.js';
import { splitArgs } from './parse.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'commit', args: '<message>', desc: 'Commit the staged changes', run: (ctx, s) => a.commit(ctx, s) },
  { name: 'amend', args: '[message]', desc: 'Amend the last commit (keeps its message if none given)', run: (ctx, s) => a.commit(ctx, s, { amend: true }) },
  { name: 'fixup', args: '[ref]', desc: 'Make the staged changes a fix for an earlier commit (picked from a list), then fold it in', complete: 'refs', run: (ctx, s) => a.fixup(ctx, s) },
  { name: 'checkout', args: '<branch|tag|hash>', desc: 'Switch to a branch, tag or commit', complete: 'refs', run: (ctx, s) => a.checkout(ctx, s) },
  { name: 'branch', args: '<name> [start]', desc: 'Create a branch and switch to it', run: (ctx, s) => a.createBranch(ctx, s) },
  { name: 'delete', args: '<branch|tag>', desc: 'Delete a branch (local or remote) or a tag', complete: 'refs', run: (ctx, s) => a.deleteRef(ctx, s) },
  { name: 'cleanup', desc: 'Delete branches and remove worktrees with nothing of yours on them (asks first)', run: (ctx) => a.cleanUp(ctx) },
  { name: 'merge', args: '<ref>', desc: 'Merge a ref into the current branch', complete: 'refs', run: (ctx, s) => a.merge(ctx, s) },
  { name: 'rebase', args: '[-i] <ref>', desc: 'Rebase the current branch onto a ref (-i: edit the commits after it)', complete: 'refs', run: (ctx, s) => a.rebase(ctx, s) },
  { name: 'compare', args: '<ref> [base]', desc: 'Full diff of what a branch adds to the default branch (or to base)', complete: 'refs', run: (ctx, s) => a.compare(ctx, s) },
  { name: 'fetch', args: '[remote]', desc: 'Fetch all remotes and prune deleted branches', run: (ctx, s) => a.fetch(ctx, splitArgs(s)) },
  { name: 'pull', args: '[--rebase]', desc: 'Pull the current branch', run: (ctx, s) => a.pull(ctx, splitArgs(s)) },
  { name: 'push', args: '[--force]', desc: 'Push the current branch (sets the upstream the first time)', run: (ctx, s) => a.push(ctx, splitArgs(s)) },
  { name: 'stash', args: '[message]', desc: 'Stash all changes, untracked files included', run: (ctx, s) => a.stash(ctx, s) },
  { name: 'discard', desc: 'Discard all uncommitted changes (asks first)', run: (ctx) => a.discardAll(ctx) },
  { name: 'pop', args: '[stash@{n}]', desc: 'Apply a stash and drop it', run: (ctx, s) => a.stashApply(ctx, s, { pop: true }) },
  { name: 'tag', args: '<name> [ref]', desc: 'Create a tag', run: (ctx, s) => a.tag(ctx, s) },
  { name: 'worktree', args: '<path> [ref]', desc: 'Add a worktree at a path (relative to the repository), checking out a ref', run: (ctx, s) => a.addWorktree(ctx, s) },
  { name: 'reset', args: '<ref>', desc: 'Move the current branch to a ref (soft, mixed or hard)', complete: 'refs', run: (ctx, s) => a.reset(ctx, s) },
  { name: 'pr', args: '<title> [--into <branch>] [--draft]', desc: 'Open a pull request from the current branch', run: (ctx, s) => a.createPr(ctx, s) },
  { name: 'comment', args: '<text>', desc: 'Comment on the pull request picked in PRs', run: (ctx, s) => a.prComment(ctx, s) },
  { name: 'approve', desc: 'Approve the pull request picked in PRs', run: (ctx) => a.prApprove(ctx, ctx.selectedPr) },
  { name: 'describe', desc: 'Claude writes the commit message for the staged changes', run: (ctx) => a.describeCommit(ctx) },
  { name: 'draft-pr', args: '[--into <branch>]', desc: 'Claude drafts a pull request (title and description) for the current branch', run: (ctx, s) => a.draftPr(ctx, s) },
  { name: 'explain', args: '[ref]', desc: 'Claude explains a commit (HEAD if none given)', complete: 'refs', run: (ctx, s) => a.claudeRef(ctx, 'explain', s) },
  { name: 'review', args: '[ref]', desc: 'Claude reviews a commit, or your changes if none given', complete: 'refs', run: (ctx, s) => a.claudeRef(ctx, 'review', s) },
  {
    name: 'reword',
    args: '<message>',
    desc: 'New message for the commit picked in the rebase editor',
    run: (ctx, s) => (ctx.rebaseEditor ? (s ? ctx.rebaseEditor.reword(s) : ctx.note('Type the new message after /reword.', 'error')) : ctx.note('Open the rebase editor first: i on a commit in the graph.', 'error')),
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
  { name: 'open', args: '<path>', desc: 'Open a repository', complete: 'repos', run: (ctx, s) => (s ? ctx.openRepo(s) : ctx.prefill('/open ')) },
  { name: 'scan', args: '<folder>', desc: 'Add a folder to scan for repositories', run: (ctx, s) => ctx.addRoot(s) },
  { name: 'last', desc: 'Show the full output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'refresh', desc: 'Reload the repository', run: (ctx) => ctx.refresh() },
  { name: 'help', desc: 'Keyboard shortcuts', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Tiller', run: (ctx) => ctx.quit() },
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
