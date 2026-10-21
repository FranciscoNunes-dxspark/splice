// Claude through the Claude Code CLI (`claude -p`), signed in as you already are, so Splice never
// sees a key. The prompts and the parsing of answers are pure, for tests; `ask` runs the CLI.
import { hasMarkers } from './conflict.js';
import { cli } from './hosting.js';
import { isoDate } from './parse.js';

// Each flag takes seconds off a call: no MCP servers to start, no settings files (whose hooks and
// plugins load on every run), no skills, and nothing saved to your session history.
const FLAGS = ['--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'];

// Explaining and reviewing may look at the rest of the repository, but never change it or run anything.
export const READ_ONLY = ['Read', 'Grep', 'Glob'];

/** Asks Claude `prompt` about `input` (sent on stdin), in `cwd`. `tools`: built-in tools it may use, none by default. */
export async function ask(prompt, { input = '', cwd, signal, tools = [] } = {}) {
  try {
    return (await cli('claude', ['-p', prompt, '--tools', tools.join(','), ...FLAGS], { cwd, signal, input })).trim();
  } catch (e) {
    if (/not installed or not on the PATH/.test(e.message)) {
      throw new Error('Claude Code (claude) is not installed or not on the PATH. Get it from https://claude.com/claude-code');
    }
    throw e;
  }
}

const MAX_INPUT = 200_000;

/** Keeps what's sent to Claude to a sensible size, saying where it was cut. */
export function clip(text, max = MAX_INPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut here: the rest (${(text.length - max).toLocaleString('en')} more characters) was left out.]`;
}

// Splice formats Markdown (src/markdown.js), but in a pane often 60 to 100 columns wide.
const FORMAT = 'Splice shows your answer in a terminal and formats Markdown: headings, bold, "-" lists, `code` and code blocks are fine. Keep it compact and avoid wide tables.';

/**
 * What to ask for the commit message of the staged changes. `recent` are the repository's latest commit
 * messages (a subject, then maybe a blank line and a body), to match their style, bodies and all.
 */
export function commitPrompt(recent) {
  const shown = recent.map((m) => {
    const [subject, ...rest] = m.trim().split('\n');
    const body = rest.join('\n').trim();
    const cut = body.length > 600 ? `${body.slice(0, 600)}…` : body;
    return `- ${subject}${cut ? `\n${cut.replace(/^/gm, '  ')}` : ''}`;
  });
  return [
    'Write the git commit message for the staged changes in the diff on standard input.',
    'Reply with the message only, no quotes, no code fences: the subject line first (under 72 characters, no trailing period).',
    'When the change needs explaining (why it was made, or what the diff alone does not make clear), follow it with a blank line and a short body in plain text, wrapped at 72 characters, without headings. A small or self-explanatory change gets the subject alone.',
    shown.length
      ? `Match the style of this repository's recent commits, including how often they have a body and how it reads (bodies indented):\n${shown.join('\n')}`
      : 'Use the imperative mood ("Add", "Fix").',
  ].join('\n');
}

export function prPrompt(branch, target) {
  return [
    `Draft a pull request that merges the branch ${branch} into ${target}.`,
    "Standard input has the branch's commit messages (oldest first), then its full diff against the target.",
    'Reply in exactly this form and nothing else: the title on the first line (under 72 characters, no quotes),',
    'a blank line, then the description in Markdown: what changes and why, and anything a reviewer should check.',
  ].join('\n');
}

/** What to ask for explaining (`mode` "explain") or reviewing ("review") one `subject` ("this commit", ...). */
export function lookPrompt(mode, subject) {
  const task =
    mode === 'explain'
      ? `Explain ${subject} for someone reading the history: what it changes, and why, as far as the change shows. Start with a two or three sentence summary, then the notable changes.`
      : `Review ${subject} for bugs, risky behaviour and missing cases. List concrete findings, most important first, each with the file and line and why it matters. If you find nothing significant, say so plainly rather than inventing issues.`;
  return [
    task,
    'Standard input has the change.',
    "You may read other files in the repository for context; the working tree may have moved on since the change was made.",
    FORMAT,
  ].join('\n');
}

const lineSpan = (from, to) => (from === to ? `line ${from}` : `lines ${from}–${to}`);

/** What to ask for explaining lines `from` to `to` of `path` from its blame; `blameInput` makes what goes on stdin. */
export function blamePrompt(path, from, to) {
  return [
    `Explain why ${lineSpan(from, to)} of ${path} ${from === to ? 'is' : 'are'} the way ${from === to ? 'it is' : 'they are'}: what the code does, and how and why it came to be written like this, going by the commits that changed it and their messages.`,
    'Standard input has the lines with who last changed each one, the file around them, and the history of the lines (git log -L): the commits that changed them, newest first, each with its message and what it did to them.',
    'Start with a two or three sentence answer, then the changes that shaped the lines, naming commits by their short hash. Where the history does not say why, say so plainly rather than guessing.',
    'You may read other files in the repository for context.',
    FORMAT,
  ].join('\n');
}

const MAX_LINE_HISTORY = 80_000;

/**
 * Claude's input for explaining some lines: `lines` are the blame rows picked ({ line, text, commit }),
 * `around` the file's rows near them (the same shape), `history` the `git log -L` output for them (cut
 * to a size), `rev` the commit the file was blamed at (null for the working tree).
 */
export function blameInput({ path, rev = null, lines, around, history }) {
  const from = lines[0].line;
  const to = lines.at(-1).line;
  const numW = String(around.at(-1)?.line ?? to).length;
  const who = (c) => (c.uncommitted ? 'not committed yet' : `${c.hash.slice(0, 7)} ${c.author}, ${isoDate(c.time, c.tz)}: ${c.summary}`);
  return [
    `File: ${path}${rev ? ` as of ${rev}` : ', as it is in the working tree'}`,
    '',
    `${lineSpan(from, to).replace(/^./, (c) => c.toUpperCase())}, each with the commit that last changed it:`,
    ...lines.map((l) => `${String(l.line).padStart(numW)} │ ${l.text}    [${who(l.commit)}]`),
    '',
    `The file around them (lines ${around[0].line}–${around.at(-1).line}):`,
    ...around.map((l) => `${String(l.line).padStart(numW)} │ ${l.text}`),
    '',
    'The history of the lines (git log -L), newest first:',
    history.trim() ? clip(history.trim(), MAX_LINE_HISTORY) : 'None: the lines are not committed yet.',
  ].join('\n');
}

/** What to ask for resolving the conflicts in the file at `path`; `resolveInput` makes what goes on stdin. */
export function resolvePrompt(path) {
  return [
    `Resolve the merge conflicts in ${path}.`,
    'Standard input says what each side of the conflict is, with its commit message, then has the whole file with its conflict markers (<<<<<<< ours, ||||||| base if present, =======, >>>>>>> theirs).',
    'Keep what both sides meant to do wherever they can live together; where they truly contradict, go by what the commit messages say each side intended. Leave everything outside the conflicts exactly as it is.',
    'You may read other files in the repository for context.',
    'Reply with the complete resolved file and nothing else: no explanation before or after it, no code fences, no conflict markers.',
  ].join('\n');
}

// Who "ours" and "theirs" are, for each operation that stops on conflicts (a rebase turns them round).
const SIDES = {
  merging: ['the branch you are on', 'the branch being merged in'],
  rebasing: ['the branch being rebased onto, with the commits replayed so far', 'the commit being replayed'],
  'cherry-picking': ['the branch you are on', 'the commit being cherry-picked'],
  reverting: ['the branch you are on', 'undoing the commit being reverted'],
};

/**
 * Claude's input for resolving a conflicted file: `state` is the operation in progress (data.state, or null,
 * for a stash say), `ours` and `theirs` are { ref, message } or null when unknown, `text` the file as it is.
 */
export function resolveInput({ path, state, ours, theirs, text }) {
  const [oursRole, theirsRole] = SIDES[state] ?? ['the branch you are on', 'the changes being applied (a stash, say)'];
  const side = (name, role, s) => `${name}: ${role}${s ? `, ${s.ref}:\n${s.message}` : '.'}`;
  return [`File: ${path}`, '', side('Ours', oursRole, ours), '', side('Theirs', theirsRole, theirs), '', 'The file, with its conflict markers:', text].join('\n');
}

/** The resolved file in Claude's answer, without code fences around it; `error` says why there's none. */
export function parseResolution(answer) {
  let text = (answer ?? '').replace(/\r\n/g, '\n');
  const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1];
  if (!text.trim()) return { error: "Claude didn't send back a resolved file." };
  if (hasMarkers(text)) return { error: "Claude's answer still has conflict markers, so it wasn't used." };
  return { text };
}

/** The commit subject in Claude's answer: its first line, without quotes or a "Subject:" label. */
export function cleanSubject(answer) {
  const line = (answer ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line
    .replace(/^(subject|commit message|title)\s*:\s*/i, '')
    .replace(/^(["'`])(.*)\1$/, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The title (first line) and description (the rest) of a pull request draft. */
export function parsePrDraft(answer) {
  const lines = (answer ?? '').replace(/\r/g, '').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: '', body: '' };
  const title = cleanSubject(lines[first].replace(/^#+\s*/, ''));
  return { title, body: lines.slice(first + 1).join('\n').trim() };
}

/** A commit message in Claude's answer: { subject, body }, the body empty when it wrote just a subject. */
export function parseCommitMessage(answer) {
  let text = (answer ?? '').replace(/\r\n/g, '\n');
  const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1];
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { subject: '', body: '' };
  const subject = cleanSubject(lines[first].replace(/^#+\s*/, ''));
  const body = lines
    .slice(first + 1)
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\s*body\s*:[ \t]*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { subject, body };
}

/** What to ask for splitting a large change into commits; `splitInput` makes what goes on stdin. */
export function splitPrompt(recentSubjects) {
  return [
    'Standard input has uncommitted changes in a git repository, cut into numbered hunks (H1, H2, ...), each with its file.',
    'Group the hunks into a few logical commits, each one change that makes sense on its own, in the order they should be committed.',
    'Every hunk goes in exactly one commit. Keep hunks that depend on each other in the same commit.',
    'Reply in exactly this form and nothing else, one block per commit, a blank line between blocks:',
    'COMMIT: <subject line, under 72 characters, no quotes, no trailing period>',
    'HUNKS: H1 H4 H5',
    recentSubjects.length ? `Match the style of this repository's recent commit subjects:\n${recentSubjects.map((s) => `- ${s}`).join('\n')}` : 'Use the imperative mood ("Add", "Fix").',
  ].join('\n');
}

/** The hunks, numbered, for Claude to group. */
export function splitInput(units) {
  return units.map((u) => `### ${u.id} (${u.path})\n${u.text}`).join('\n\n');
}

/**
 * Claude's grouping: { groups: [{ message, ids }], leftover: [ids no group took], error }. Hunks it named twice
 * stay in the first group; ids it made up are dropped, and groups left without hunks with them.
 */
export function parseSplit(answer, ids) {
  const known = new Set(ids);
  const taken = new Set();
  const groups = [];
  let cur = null;
  for (const raw of (answer ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/^[\s*#>-]+/, '').replace(/\*\*/g, '');
    const commit = /^commit\s*\d*\s*:\s*(.+)$/i.exec(line);
    if (commit) {
      cur = { message: cleanSubject(commit[1]), ids: [] };
      groups.push(cur);
      continue;
    }
    const hunks = /^hunks?\s*:\s*(.*)$/i.exec(line);
    if (hunks && cur) {
      for (const m of hunks[1].matchAll(/\bH(\d+)\b/gi)) {
        const id = `H${m[1]}`;
        if (known.has(id) && !taken.has(id)) {
          taken.add(id);
          cur.ids.push(id);
        }
      }
    }
  }
  const kept = groups.filter((g) => g.message && g.ids.length);
  return {
    groups: kept,
    leftover: ids.filter((id) => !taken.has(id)),
    error: kept.length ? null : "Claude didn't propose any commits. Try again, or commit the changes yourself.",
  };
}
