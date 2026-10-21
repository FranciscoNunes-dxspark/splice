// Conflict forecasts: whether merging two commits would conflict, and in which files, from
// `git merge-tree --write-tree` (git 2.38 and later), which merges in the object store alone: the
// working tree, the index and HEAD stay as they are. Which files conflict doesn't depend on which side
// is which, so one answer serves a merge either way round; for a rebase, which replays one commit at a
// time, it's an estimate. Answers are kept per pair of commits, so each pair costs one git, once.
// The parsing and wording are pure; `forecast` runs git.
import { git, run } from './git.js';

/** The first git with `merge-tree --write-tree` (and `rebase --update-refs`). */
export const MIN_GIT = [2, 38];

/** "git version 2.43.0", "git version 2.39.2.windows.1", "git version 2.37.1 (Apple Git-137.1)" → [2, 43, 0]. */
export function parseGitVersion(raw) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export const atLeast = (version, [major, minor]) => Boolean(version) && (version[0] > major || (version[0] === major && version[1] >= minor));

export const forecastArgs = (a, b) => ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b];

/**
 * Parses `git merge-tree --write-tree --name-only --no-messages -z`: exit 0 is a clean merge; exit 1 is
 * one with conflicts when the output is the tree and then the conflicted paths, and otherwise an error
 * (a ref that doesn't exist also exits 1). Null for an error.
 */
export function parseForecast(stdout, code) {
  if (code === 0) return { conflicts: false, files: [] };
  const [tree, ...rest] = (stdout ?? '').split('\0');
  if (code !== 1 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) return null;
  return { conflicts: true, files: [...new Set(rest.filter(Boolean))] };
}

/** "a.txt, b.txt and 3 more" */
export function fileList(files, n = 3) {
  const shown = files.slice(0, n).join(', ');
  return files.length > n ? `${shown} and ${files.length - n} more` : shown;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A short sentence for a question about a merge or rebase (it leads the question's one line of detail):
 * `how` is 'merge' or 'rebase'. A rebase is only estimated, since it replays the commits one at a time.
 */
export function forecastLine(f, how = 'merge') {
  if (!f) return '';
  if (how === 'rebase') return f.conflicts ? `Expect conflicts in ${fileList(f.files)} (an estimate, by git merge-tree).` : 'No conflicts expected (an estimate, by git merge-tree).';
  return f.conflicts ? `Would conflict in ${fileList(f.files)} (git merge-tree).` : 'Merges without conflicts (git merge-tree).';
}

/** What /forecast says about `ref` and `base`. */
export function forecastText(f, ref, base) {
  const rebase = 'A rebase replays the commits one at a time, so it may stop on other files, or on none: take this as an estimate for one.';
  if (!f.conflicts) return `${ref} and ${base} merge without conflicts, either way round.\n${rebase}`;
  return [`${ref} and ${base} would conflict in ${plural(f.files.length, 'file')}, merging either way round:`, ...f.files.map((p) => `  ${p}`), rebase].join('\n');
}

export class ForecastUnsupported extends Error {}

let version = null;

/** git's version, asked once per run. */
export function gitVersion(root) {
  version ??= git(root, ['--version']).then(parseGitVersion, () => null);
  return version;
}

/** Says why forecasts can't be made with this git, or null when they can. */
export async function unsupported(root) {
  const v = await gitVersion(root);
  if (atLeast(v, MIN_GIT)) return null;
  return `Conflict forecasts need git ${MIN_GIT.join('.')} or later (git merge-tree --write-tree)${v ? `; this is git ${v.join('.')}` : ''}.`;
}

const cache = new Map();
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** The answer already known for two commits, by their hashes, if any. */
export const knownForecast = (a, b) => (a && b ? cache.get(pairKey(a, b)) : undefined);

/**
 * Whether merging `a` and `b` (any refs) would conflict: { conflicts, files }. `oids`, their commit
 * hashes when known, keeps the answer for the pair. Throws ForecastUnsupported on a git before 2.38.
 */
export async function forecast(root, a, b, { signal, oids = null } = {}) {
  const why = await unsupported(root);
  if (why) throw new ForecastUnsupported(why);
  const known = oids && knownForecast(...oids);
  if (known) return known;
  const { stdout, stderr, code } = await run(root, forecastArgs(a, b), { signal, codes: [1] });
  const result = parseForecast(stdout, code);
  if (!result) throw new Error((stderr || stdout).trim() || `git merge-tree exited with ${code}`);
  if (oids) {
    cache.set(pairKey(...oids), result);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return result;
}
