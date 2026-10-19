import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from './git.js';
import { parseStatus } from './parse.js';

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
  for (const root of roots) await walk(resolve(root), depth);
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
