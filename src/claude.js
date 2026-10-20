// Claude through the Claude Code CLI (`claude -p`), signed in as you already are, so Splice never
// sees a key. The prompts and the parsing of answers are pure, for tests; `ask` runs the CLI.
import { hasMarkers } from './conflict.js';
import { cli } from './hosting.js';

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

export function commitPrompt(recentSubjects) {
  return [
    'Write the git commit message for the staged changes in the diff on standard input.',
    'Reply with the subject line only: one line, under 72 characters, no quotes, no trailing period.',
    recentSubjects.length
      ? `Match the style of this repository's recent commit subjects:\n${recentSubjects.map((s) => `- ${s}`).join('\n')}`
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
