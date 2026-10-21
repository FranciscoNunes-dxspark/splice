// /absorb (Z in Changes), after git-absorb: each staged hunk becomes a fixup! commit for the branch's commit
// that last changed its lines. Pure: which lines of a hunk to blame, reading the blame, the plan and the patches.
// actions.js asks git (the staged diff, one blame per file, the branch's commits) and makes the commits.
import { buildPatch, hunkPicks, parseDiff, splitFiles } from './patch.js';

const short = (hash) => hash.slice(0, 7);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a file's staged change can't go into another commit hunk by hunk, or null when it's a plain change to
 * a text file's lines. Added, deleted and renamed files, binaries, mode changes and submodules stay staged.
 */
export function fileProblem(diff) {
  const head = diff.header.join('\n');
  if (/^new file mode/m.test(head)) return 'a new file';
  if (/^deleted file mode/m.test(head)) return 'a deleted file';
  if (/^(rename|copy) from /m.test(head)) return 'renamed';
  if (/^old mode /m.test(head)) return 'its mode changed';
  if (/^index \S+ 160000$/m.test(head)) return 'a submodule';
  if (/^Binary files |^GIT binary patch/m.test(head)) return 'a binary file';
  if (!diff.hunks.length) return 'no lines changed';
  return null;
}

/** Splits `git diff --cached` into files: { path, diff, problem }. */
export function absorbFiles(diffText) {
  return splitFiles(diffText).map((f) => {
    const diff = parseDiff(f.text);
    return { path: f.path, diff, problem: fileProblem(diff) };
  });
}

/**
 * The lines of the old file (HEAD) that say where a hunk belongs: the lines it removes or replaces, and for
 * lines only added, the line just above and the line just below them (those there are).
 */
export function blameTargets(hunk) {
  const out = new Set();
  let old = hunk.oldStart;
  let run = null;
  const close = (after) => {
    if (run && !run.removes) {
      if (run.before >= 1) out.add(run.before);
      if (after != null) out.add(after);
    }
    run = null;
  };
  for (const line of hunk.lines) {
    const t = line[0];
    if (t === '\\') continue;
    if (t === '+' || t === '-') {
      if (!run) run = { before: old - 1, removes: false };
      if (t === '-') {
        run.removes = true;
        out.add(old);
        old++;
      }
      continue;
    }
    close(old);
    old++;
  }
  // A run at the very end of a hunk is at the end of the file: nothing below it.
  close(null);
  return [...out].sort((a, b) => a - b);
}

/** Line numbers as the fewest `-L from,to` ranges. */
export function lineRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** The line, in the staged file, where a hunk's first change is. */
export function firstChangeLine(hunk) {
  let line = hunk.newStart;
  for (const l of hunk.lines) {
    if (l[0] === '+' || l[0] === '-') return line;
    if (l[0] === ' ') line++;
  }
  return hunk.newStart;
}

/** parse.js's parseBlame lines as a map: line number → { hash, summary }. */
export function blameMap(lines) {
  const map = new Map();
  for (const l of lines) map.set(l.line, { hash: l.commit.hash, summary: l.commit.summary });
  return map;
}

const FIXUP = /^(?:fixup|squash|amend)! (.*)$/;

/**
 * The plan. `files` from absorbFiles; `blames`: path → blameMap of its HEAD lines; `commits`: the branch's own
 * commits, newest first ({ hash, subject, parents }). A hunk whose lines all come from one of those commits
 * goes to it (a fixup! commit counts as the commit it fixes, when that's on the branch too); the rest stay.
 * Returns { groups: [{ commit, hunks: [{ path, index, line }] }] newest commit first, stays: [{ path, line, why }],
 * oldest: the oldest commit given a fixup, or null }.
 */
export function planAbsorb(files, blames, commits) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const owner = (hash) => {
    const c = byHash.get(hash);
    if (!c) return null;
    const m = FIXUP.exec(c.subject);
    return (m && commits.find((x) => x.subject === m[1] && !FIXUP.test(x.subject))) || c;
  };
  const groups = new Map();
  const stays = [];
  for (const f of files) {
    if (f.problem) {
      stays.push({ path: f.path, line: null, why: f.problem });
      continue;
    }
    const blame = blames.get(f.path);
    f.diff.hunks.forEach((h, index) => {
      const line = firstChangeLine(h);
      const stay = (why) => stays.push({ path: f.path, line, why });
      const targets = blameTargets(h);
      if (!targets.length) return stay('no lines around it to go by');
      if (!blame) return stay("its lines couldn't be blamed");
      const found = targets.map((n) => blame.get(n));
      if (found.some((b) => !b)) return stay("its lines couldn't be blamed");
      const hashes = [...new Set(found.map((b) => b.hash))];
      const owners = [...new Set(hashes.map(owner))];
      if (owners.length === 1 && owners[0]) {
        const c = owners[0];
        if (!groups.has(c.hash)) groups.set(c.hash, { commit: c, hunks: [] });
        groups.get(c.hash).hunks.push({ path: f.path, index, line });
        return;
      }
      if (hashes.length > 1) return stay(`its lines come from ${hashes.length} commits (${hashes.map(short).join(', ')})`);
      const b = found[0];
      stay(`its lines come from ${short(b.hash)} "${b.summary}", which isn't one of the branch's own commits`);
    });
  }
  const order = (c) => commits.indexOf(c);
  const list = [...groups.values()].sort((a, b) => order(a.commit) - order(b.commit));
  return { groups: list, stays, oldest: list.at(-1)?.commit ?? null };
}

/** The patch that stages just a group's hunks, for `git apply --cached`: each of its files' picked hunks. */
export function groupPatch(files, group) {
  const out = [];
  for (const f of files) {
    const mine = group.hunks.filter((h) => h.path === f.path);
    if (!mine.length) continue;
    const picks = new Map();
    for (const h of mine) for (const [k, v] of hunkPicks(f.diff, h.index)) picks.set(k, v);
    const patch = buildPatch(f.diff, picks);
    if (patch) out.push(patch);
  }
  return out.join('');
}

const hunkCount = (plan) => plan.groups.reduce((n, g) => n + g.hunks.length, 0);

/** "3 hunks into 2 commits" */
export function absorbSummary(plan) {
  return `${plural(hunkCount(plan), 'hunk')} into ${plural(plan.groups.length, 'commit')}`;
}

/** The plan for the viewer: each commit with the hunks that go to it, then what stays staged and why. */
export function absorbText(plan, { own = true } = {}) {
  const where = (h) => (h.line == null ? h.path : `${h.path}:${h.line}`);
  const out = [];
  if (plan.groups.length) {
    out.push(`Into the branch's commits, as fixup! commits (${absorbSummary(plan)})`);
    for (const g of plan.groups) {
      out.push(`  ${short(g.commit.hash)} ${g.commit.subject}`, ...g.hunks.map((h) => `      ${where(h)}`));
    }
    out.push('');
  }
  if (plan.stays.length) {
    const w = Math.min(40, Math.max(...plan.stays.map((s) => where(s).length)));
    out.push(`Staying staged (${plan.stays.length})`, ...plan.stays.map((s) => `  ${where(s).padEnd(w)}  ${s.why}`), '');
  }
  if (!own) out.push("The branch has no commits of its own that aren't on its upstream or the default branch, so these are the latest 30.");
  return out.join('\n').trimEnd();
}
