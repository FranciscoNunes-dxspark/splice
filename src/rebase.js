// Interactive rebase without an editor: Tiller writes git's todo list itself and hands it over
// through GIT_SEQUENCE_EDITOR. Rewording runs `git commit --amend -F <file>` right after the pick.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';

export const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** The commits from `base` (exclusive; null for the root) up to HEAD, oldest first. */
export async function loadPlan(root, base) {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = await git(root, ['log', '--reverse', '--format=%H%x1f%s%x1f%P%x1f%B%x1e', range]);
  return out
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((s) => {
      const [hash, subject, parents, body] = s.split('\x1f');
      return { hash, subject, merge: parents.split(' ').length > 1, message: body.trimEnd(), action: 'pick' };
    });
}

/** What's wrong with a plan (oldest first), or null if git will accept it. */
export function planProblem(rows) {
  const kept = rows.filter((r) => r.action !== 'drop');
  if (kept[0] && (kept[0].action === 'squash' || kept[0].action === 'fixup')) {
    return `The oldest commit kept can't be squashed or fixed up: there's nothing older in the plan to fold it into.`;
  }
  const empty = rows.find((r) => r.action === 'reword' && !r.newMessage?.trim());
  if (empty) return `Give ${empty.hash.slice(0, 7)} its new message first (r).`;
  return null;
}

// Quotes for the sh that git runs exec lines and the sequence editor through.
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const shPath = (p) => shQuote(p.replace(/\\/g, '/'));

/**
 * The todo text for `rows` (oldest first). `messageFile(i)` names the file holding
 * row i's new message; returns the todo and the messages to write.
 */
export function buildTodo(rows, messageFile) {
  const lines = [];
  const messages = [];
  rows.forEach((r, i) => {
    if (r.action === 'reword') {
      const file = messageFile(i);
      messages.push({ file, text: `${r.newMessage.trim()}\n` });
      lines.push(`pick ${r.hash} ${r.subject}`, `exec git commit --amend --quiet --allow-empty -F ${shPath(file)}`);
    } else {
      lines.push(`${r.action} ${r.hash} ${r.subject}`);
    }
  });
  return { todo: `${lines.join('\n')}\n`, messages };
}

/** Writes the todo and message files under .git and returns the env that makes `git rebase -i` use them. */
export async function prepare(gitDir, rows) {
  const dir = join(gitDir, 'tiller-rebase');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const { todo, messages } = buildTodo(rows, (i) => join(dir, `message-${i}.txt`));
  const todoFile = join(dir, 'todo');
  await writeFile(todoFile, todo);
  for (const m of messages) await writeFile(m.file, m.text);
  // git calls the sequence editor with the path of its own todo list; copying ours over it is all it takes.
  return { dir, env: { GIT_SEQUENCE_EDITOR: `cp ${shPath(todoFile)}` } };
}

/** Removes the files once no rebase needs them (a stopped rebase still runs its exec lines later). */
export function cleanup(gitDir) {
  return rm(join(gitDir, 'tiller-rebase'), { recursive: true, force: true });
}

/** "2 squashed, 1 dropped, 1 reworded" */
export function planSummary(rows) {
  const counts = {};
  for (const r of rows) if (r.action !== 'pick') counts[r.action] = (counts[r.action] ?? 0) + 1;
  const words = { reword: 'reworded', edit: 'stopped for editing', squash: 'squashed', fixup: 'fixed up', drop: 'dropped' };
  return Object.entries(counts).map(([a, n]) => `${n} ${words[a]}`).join(', ') || 'reordered';
}
