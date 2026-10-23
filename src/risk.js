// Risk before push (/risk, and P when the score is high): how risky the commits about to be pushed look,
// from their files' recent history. Pure: actions.js's `readRisk` runs the three gits these read (the
// outgoing commits with their files, the sizes of what they write, and the last 90 days of those files).
const MB = 1024 * 1024;

/** How many of one kind of reason count towards the score at most, so one long list doesn't decide it. */
const CAP = 2;
/** A file changed in this many commits in the last 90 days is one that moves a lot. */
export const HOT = 10;
/** A file this big (or binary) is a large one. */
export const LARGE = MB;
/** At most this many files are looked up in the history: past it, the change is big enough to say so. */
export const MAX_FILES = 200;

const RECORD = '%x1e%H%x1f%ae%x1f%s';

/** `git log` arguments for the outgoing commits (rev-list arguments `range`): each one's files, blob ids and line counts. */
export const outgoingArgs = (range, max = 300) => ['log', `--max-count=${max}`, '--no-merges', '--no-renames', '--raw', '--no-abbrev', '--numstat', `--format=${RECORD}`, ...range, '--'];

/** `git log` arguments for the last 90 days of `files` on HEAD: who changed them, and how often. */
export const historyArgs = (files) => ['log', '--since=90.days', '--no-merges', '--no-renames', '--numstat', `--format=${RECORD}`, 'HEAD', '--', ...files];

/**
 * Either log's output: [{ hash, email, subject, files: [{ path, added, deleted, binary, blob }] }]. `blob`
 * (from --raw) is the file's new blob id, null when the commit deletes it or without --raw.
 */
export function parseRiskLog(raw) {
  const out = [];
  for (const rec of String(raw ?? '').split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const [head, ...lines] = rec.split('\n');
    const [hash, email, subject] = head.split('\x1f');
    const files = new Map();
    const file = (path) => files.get(path) ?? files.set(path, { path, added: 0, deleted: 0, binary: false, blob: null }).get(path);
    for (const l of lines) {
      let m;
      if ((m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) (\w)\d*\t(.+)$/.exec(l))) file(m[3]).blob = m[2] === 'D' || /^0+$/.test(m[1]) ? null : m[1];
      else if ((m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))) {
        const f = file(m[3]);
        if (m[1] === '-') f.binary = true;
        else (f.added += Number(m[1])), (f.deleted += Number(m[2]));
      }
    }
    out.push({ hash, email: (email ?? '').toLowerCase(), subject: subject ?? '', files: [...files.values()] });
  }
  return out;
}

/** Whether a path is a test: in a test folder, or named as one (`.test.js`, `_test.go`, `test_x.py`, `FooTests.cs`). */
export const isTest = (path) =>
  /(^|\/)(tests?|__tests__|specs?|testing|e2e|integration-tests?)\//i.test(path) || /[._-](test|spec)s?\.[a-z0-9]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/i.test(path) || /Tests?\.(cs|java|kt|swift|php|scala)$/.test(path);

/** Whether a path is source code (that tests would cover), by its extension. */
export const isSource = (path) => /\.(m?[jt]sx?|cjs|py|go|cs|java|kt|kts|rb|rs|swift|c|cc|cpp|h|hpp|php|scala|fs|vb|ex|exs|dart|lua|clj)$/i.test(path) && !isTest(path);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const some = (list, n = 3) => (list.length > n ? `${list.slice(0, n).join(', ')} and ${list.length - n} more` : list.join(', '));
const size = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * The score of the outgoing commits: { level: 'low' | 'medium' | 'high', score, reasons: [{ points, text }],
 * commits, files, lines }. `outgoing` and `history` are parseRiskLog's; `sizes` maps blob ids to bytes.
 * Your own commits are the outgoing ones, so their authors are "you" when judging whose files they are.
 */
export function scoreRisk({ outgoing = [], history = [], sizes = new Map() }) {
  const mine = new Set(outgoing.map((c) => c.email));
  const ours = new Set(outgoing.map((c) => c.hash));
  const byPath = new Map();
  for (const c of outgoing) {
    for (const f of c.files) {
      const at = byPath.get(f.path) ?? { path: f.path, added: 0, deleted: 0, binary: false, blob: null };
      at.added += f.added;
      at.deleted += f.deleted;
      at.binary ||= f.binary;
      // Newest first: the first blob seen is what the push leaves the file as.
      if (!byPath.has(f.path)) at.blob = f.blob;
      byPath.set(f.path, at);
    }
  }
  const files = [...byPath.values()];
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const reasons = [];
  const add = (points, text) => points > 0 && reasons.push({ points, text });

  if (lines >= 1000) add(3, `${lines} lines changed: a lot to review at once`);
  else if (lines >= 400) add(2, `${lines} lines changed`);
  else if (lines >= 150) add(1, `${lines} lines changed`);
  if (files.length > 25) add(1, `${files.length} files changed`);

  // Each file's last 90 days, without the commits being pushed.
  const churn = new Map();
  const authors = new Map();
  for (const c of history) {
    if (ours.has(c.hash)) continue;
    for (const f of c.files) {
      churn.set(f.path, (churn.get(f.path) ?? 0) + 1);
      if (!authors.has(f.path)) authors.set(f.path, new Set());
      authors.get(f.path).add(c.email);
    }
  }
  const hot = files.filter((f) => (churn.get(f.path) ?? 0) >= HOT).sort((a, b) => churn.get(b.path) - churn.get(a.path));
  if (hot.length) add(Math.min(CAP, hot.length), `${hot.length === 1 ? 'A file that changes' : 'Files that change'} a lot: ${some(hot.map((f) => `${f.path} (${plural(churn.get(f.path), 'commit')} in 90 days)`))}`);
  const theirs = files.filter((f) => authors.get(f.path)?.size && ![...authors.get(f.path)].some((e) => mine.has(e)));
  if (theirs.length) add(Math.min(CAP, theirs.length), `Only others changed ${theirs.length === 1 ? 'this file' : 'these files'} recently: ${some(theirs.map((f) => `${f.path} (${some([...authors.get(f.path)], 2)})`))}`);
  const source = files.filter((f) => isSource(f.path));
  if (source.length && !files.some((f) => isTest(f.path))) add(2, `Source changed with no test changed alongside: ${some(source.map((f) => f.path))}`);
  // What the push leaves in place: a file it deletes isn't large any more.
  const large = files.filter((f) => f.blob && (f.binary || (sizes.get(f.blob) ?? 0) >= LARGE));
  if (large.length) add(Math.min(CAP, large.length), `Large or binary ${large.length === 1 ? 'file' : 'files'}: ${some(large.map((f) => (sizes.get(f.blob) ? `${f.path} (${size(sizes.get(f.blob))})` : f.path)))}`);

  const score = reasons.reduce((n, r) => n + r.points, 0);
  const level = score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
  return { level, score, reasons, commits: outgoing.length, files: files.length, lines };
}

/** The files to look up in the history, at most MAX_FILES. */
export const riskFiles = (outgoing) => [...new Set(outgoing.flatMap((c) => c.files.map((f) => f.path)))].slice(0, MAX_FILES);

/** The blob ids to ask the sizes of. */
export const riskBlobs = (outgoing) => [...new Set(outgoing.flatMap((c) => c.files.map((f) => f.blob).filter(Boolean)))];

/** "high (7): 3 commits, 12 files, 840 lines" */
export const riskSummary = (r) => `${r.level} (${r.score}): ${plural(r.commits, 'commit')}, ${plural(r.files, 'file')}, ${plural(r.lines, 'line')}`;

/** The viewer's text: the level, then each reason with its points. */
export function riskText(r) {
  const out = [`Risk ${riskSummary(r)}`, ''];
  if (!r.reasons.length) out.push('Nothing stands out: a small change to files you know, with tests.');
  for (const x of r.reasons) out.push(`  +${x.points}  ${x.text}`);
  out.push('', 'Low under 3, medium from 3, high from 6. Churn and authors are from the last 90 days of each file on HEAD.');
  return out.join('\n');
}
