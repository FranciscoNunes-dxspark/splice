// Pure parsers for git's machine-readable output. No I/O here, so tests can feed them strings.

export const LOG_FORMAT = '%x1f%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s';
export const REF_FORMAT =
  '%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(creatordate:unix)%1f%(contents:subject)';
export const STASH_FORMAT = '%gd%x1f%at%x1f%gs';

// Splits `s` on its first `n` spaces; the remainder (a path, which may hold spaces) is the last field.
function splitFields(s, n) {
  const out = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = s.indexOf(' ', pos);
    if (sp < 0) break;
    out.push(s.slice(pos, sp));
    pos = sp + 1;
  }
  out.push(s.slice(pos));
  return out;
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [key, ...rest] = p.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') branch.head = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = val.match(/\+(\d+) -(\d+)/);
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const type = p[0];
    if (type === '1') {
      const f = splitFields(p, 8);
      files.push({ kind: 'changed', x: f[1][0], y: f[1][1], path: f[8] });
    } else if (type === '2') {
      const f = splitFields(p, 9);
      files.push({ kind: 'renamed', x: f[1][0], y: f[1][1], path: f[9], orig: parts[++i] });
    } else if (type === 'u') {
      const f = splitFields(p, 10);
      files.push({ kind: 'unmerged', x: f[1][0], y: f[1][1], path: f[10] });
    } else if (type === '?') {
      files.push({ kind: 'untracked', x: '?', y: '?', path: p.slice(2) });
    }
  }
  return { branch, files };
}

/** Splits status entries into what's conflicted, unstaged and staged. A file can be in both of the last two. */
export function groupChanges(files) {
  const conflicts = [];
  const unstaged = [];
  const staged = [];
  for (const f of files) {
    if (f.kind === 'unmerged') conflicts.push({ ...f, area: 'conflict', code: '!' });
    else if (f.kind === 'untracked') unstaged.push({ ...f, area: 'unstaged', code: '?' });
    else {
      if (f.x !== '.') staged.push({ ...f, area: 'staged', code: f.x });
      if (f.y !== '.') unstaged.push({ ...f, area: 'unstaged', code: f.y });
    }
  }
  return { conflicts, unstaged, staged };
}

/** Parses a `%D` decoration list printed with --decorate=full. */
export function parseDecorations(deco) {
  if (!deco) return [];
  const refs = [];
  for (let part of deco.split(', ')) {
    let head = false;
    if (part === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' });
      continue;
    }
    if (part.startsWith('HEAD -> ')) {
      head = true;
      part = part.slice(8);
    }
    if (part.startsWith('tag: ')) part = part.slice(5);
    if (part.startsWith('refs/heads/')) refs.push({ type: 'local', name: part.slice(11), head });
    else if (part.startsWith('refs/remotes/')) {
      const name = part.slice(13);
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name });
    } else if (part.startsWith('refs/tags/')) refs.push({ type: 'tag', name: part.slice(10) });
  }
  return refs;
}

/** Parses `git log --graph --format=LOG_FORMAT`. Rows without a commit are the graph's connector lines. */
export function parseGraph(raw) {
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const i = line.indexOf('\x1f');
    if (i < 0) {
      rows.push({ graph: line.trimEnd() });
      continue;
    }
    const [hash, parents, deco, author, time, subject] = line.slice(i + 1).split('\x1f');
    rows.push({
      graph: line.slice(0, i).trimEnd(),
      commit: {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: parseDecorations(deco),
        author,
        time: Number(time),
        subject: subject ?? '',
      },
    });
  }
  return rows;
}

/** Parses `%(upstream:track)`, e.g. "[ahead 1, behind 2]" or "[gone]". */
export function parseTrack(track) {
  const out = { ahead: 0, behind: 0, gone: false };
  if (!track) return out;
  if (track.includes('gone')) out.gone = true;
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  if (a) out.ahead = Number(a[1]);
  if (b) out.behind = Number(b[1]);
  return out;
}

/** Parses `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes refs/tags`. */
export function parseRefs(raw) {
  const local = [];
  const remote = [];
  const tags = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, oid, upstream, track, head, date, subject] = line.split('\x1f');
    const base = { oid, date: Number(date) || 0, subject: subject ?? '' };
    if (ref.startsWith('refs/heads/')) {
      local.push({ ...base, name: ref.slice(11), upstream: upstream || null, current: head === '*', ...parseTrack(track) });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (!name.endsWith('/HEAD') && name.includes('/')) remote.push({ ...base, name, remote: name.slice(0, name.indexOf('/')) });
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ ...base, name: ref.slice(10) });
    }
  }
  tags.sort((a, b) => b.date - a.date);
  return { local, remote, tags };
}

/** Parses `git stash list --format=STASH_FORMAT`. */
export function parseStash(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, time, message] = line.split('\x1f');
      return { ref, time: Number(time), message: message ?? '' };
    });
}

/** Parses `--name-status` lines: "M\tpath" or "R087\told\tnew". */
export function parseNameStatus(raw) {
  return raw
    .split('\n')
    .filter((l) => l && l.includes('\t'))
    .map((line) => {
      const [code, a, b] = line.split('\t');
      return b ? { code: code[0], orig: a, path: b } : { code: code[0], path: a };
    });
}

/** Splits a command line into arguments, honouring single and double quotes. Backslashes stay literal (Windows paths). */
export function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else cur += c;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** Short relative age: "now", "5m", "3h", "2d", "4mo", "1y". */
export function relTime(sec, now = Date.now() / 1000) {
  const d = Math.max(0, now - sec);
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))}mo`;
  return `${Math.floor(d / (86400 * 365))}y`;
}
