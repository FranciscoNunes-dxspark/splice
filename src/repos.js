import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, run } from './git.js';
import { parseStatus } from './parse.js';
import { canonical } from './repo.js';

const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'vendor', 'packages']);

/** Finds git working trees under each root, up to `depth` folders down. Doesn't look inside a repo once found. */
export async function discover(roots, depth = 2) {
  const found = [];
  async function walk(dir, left) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(dir);
      return;
    }
    if (left === 0) return;
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name));
    await Promise.all(dirs.map((e) => walk(join(dir, e.name), left - 1)));
  }
  // From the folder's own name for itself, so a repository found here matches the same one opened
  // elsewhere (whose root git names that way), whatever form the folder was given in.
  for (const root of roots) await walk(canonical(resolve(root)), depth);
  return found.sort((a, b) => a.localeCompare(b));
}

/** Branch, ahead/behind and number of changed files for the Repos list. */
export async function summarize(path) {
  try {
    const { branch, files } = parseStatus(await git(path, ['status', '--porcelain=v2', '--branch', '-z']));
    return { branch: branch.head, ahead: branch.ahead, behind: branch.behind, changes: files.length };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  }
}

/**
 * Why a fetch failed, in a few words for a Repos row: git's first error line, without its "fatal: ", and a
 * folder it names in quotes cut to its last part ('nowhere.git'), which is what still fits in the row.
 */
export function fetchError(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'the fetch failed';
  return line
    .replace(/^(fatal|error):\s*/i, '')
    .replace(/'((?:[a-z]:[\\/]|\\\\|\/)[^']*?)[\\/]*'/gi, (all, path) => `'${path.split(/[\\/]/).pop() || path}'`);
}

/**
 * Fetches every remote of the repository at `path` (pruning deleted branches), then reads its summary
 * again, so the row shows how far it is now behind. Resolves with { summary, error }, `error` saying why
 * the fetch failed; a cancelled fetch rejects (`cancelled`).
 */
export async function fetchRepo(path, signal) {
  let error = null;
  try {
    await run(path, ['fetch', '--all', '--prune', '--quiet'], { signal });
  } catch (e) {
    if (e.cancelled) throw e;
    error = fetchError(e.message);
  }
  return { summary: await summarize(path), error };
}

/** Runs `fn` over `items` with at most `limit` in flight, calling `onEach` as results arrive. */
export async function eachLimited(items, limit, fn, onEach) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      onEach(items[i], await fn(items[i]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
