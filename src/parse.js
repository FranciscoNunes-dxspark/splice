// Pure parsers for git's machine-readable output. No I/O here, so tests can feed them strings.

export const LOG_FORMAT = '%x1f%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s';
export const REF_FORMAT =
  '%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(creatordate:unix)%1f%(contents:subject)%1f%(symref)';
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

/**
 * Parses `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes refs/tags`.
 * `remoteHeads` has each remote's HEAD (its default branch) as a remote branch name, e.g. { origin: 'origin/main' }.
 */
export function parseRefs(raw) {
  const local = [];
  const remote = [];
  const tags = [];
  const remoteHeads = {};
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, oid, upstream, track, head, date, subject, symref] = line.split('\x1f');
    const base = { oid, date: Number(date) || 0, subject: subject ?? '' };
    if (ref.startsWith('refs/heads/')) {
      local.push({ ...base, name: ref.slice(11), upstream: upstream || null, current: head === '*', ...parseTrack(track) });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (name.endsWith('/HEAD')) {
        if (symref?.startsWith('refs/remotes/')) remoteHeads[name.slice(0, -5)] = symref.slice(13);
      } else if (name.includes('/')) remote.push({ ...base, name, remote: name.slice(0, name.indexOf('/')) });
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ ...base, name: ref.slice(10) });
    }
  }
  tags.sort((a, b) => b.date - a.date);
  return { local, remote, tags, remoteHeads };
}

/**
 * The branch others merge into, from the refs alone (no git, no server): the remote's HEAD
 * (origin first), else its main or master, else a local main or master. `ref` is what to compare
 * with: the remote's copy when there is one, since that's what a pull request goes against.
 * `name` is the branch's own name. Null when there's no telling.
 */
export function defaultBranch(refs, remotes = []) {
  const order = [...remotes].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  const hasRemote = (name) => refs.remote.some((b) => b.name === name);
  for (const r of order) {
    const head = refs.remoteHeads?.[r];
    if (head && hasRemote(head)) return { name: head.slice(r.length + 1), ref: head };
  }
  for (const r of order) {
    for (const n of ['main', 'master']) if (hasRemote(`${r}/${n}`)) return { name: n, ref: `${r}/${n}` };
  }
  for (const n of ['main', 'master']) if (refs.local.some((b) => b.name === n)) return { name: n, ref: n };
  return null;
}

/** Whether a row of the Branches view is the default branch itself: its local copy or the remote one. */
export function isDefaultBranch(def, ref, type) {
  if (!def) return false;
  if (type === 'local') return ref.name === def.ref || ref.name === def.name;
  if (type === 'remote') return ref.name === def.ref;
  return false;
}

/** Parses `git rev-list --left-right --count <base>...<ref>`: what `ref` has that `base` doesn't, and the reverse. */
export function parseAheadBehind(raw) {
  const [behind, ahead] = (raw ?? '').trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

export const COMMIT_FORMAT = '%H%x1f%h%x1f%at%x1f%s';

/** Parses `git log --format=COMMIT_FORMAT`. */
export function parseCommits(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [full, hash, time, subject] = l.split('\x1f');
      return { full, hash, time: Number(time), subject: subject ?? '' };
    });
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

/** Parses `git worktree list --porcelain -z`. The first entry is the main working tree. */
export function parseWorktrees(raw) {
  const out = [];
  let wt = null;
  for (const field of raw.split('\0')) {
    // An empty field ends one worktree's block.
    if (!field) {
      wt = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      wt = { path: val, head: null, branch: null, main: !out.length, bare: false, locked: false, prunable: false, reason: '' };
      out.push(wt);
    } else if (!wt) continue;
    else if (key === 'HEAD') wt.head = val;
    else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'bare') wt.bare = true;
    else if (key === 'locked' || key === 'prunable') {
      wt[key] = true;
      wt.reason = wt.reason || val;
    }
  }
  return out;
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

export const HISTORY_FORMAT = '%x1e%H%x1f%an%x1f%at%x1f%s';

/**
 * Parses `git log --follow -M --name-status -z --format=HISTORY_FORMAT -- <path>`: the commits that
 * touched one file, newest first, each with the path the file had in it (`orig` too, where it was renamed).
 * A commit without a file line (a merge) keeps the path of the commit after it.
 */
export function parseFileHistory(raw, path) {
  const out = [];
  let cur = path;
  for (const chunk of raw.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split('\0');
    const [hash, author, time, subject] = head.split('\x1f');
    // The file lines follow a blank line, which -z leaves at the start of the first field.
    const fields = rest.map((s) => s.replace(/^\n+/, '')).filter(Boolean);
    const entry = { hash, author: author ?? '', time: Number(time) || 0, subject: subject ?? '', status: null, path: cur, orig: null };
    if (fields.length >= 2) {
      entry.status = fields[0][0];
      if ((entry.status === 'R' || entry.status === 'C') && fields.length >= 3) {
        entry.orig = fields[1];
        entry.path = fields[2];
      } else entry.path = fields[1];
      // Older commits know the file by its name before the rename.
      cur = entry.orig ?? entry.path;
    }
    out.push(entry);
  }
  return out;
}

const ZERO_HASH = /^0+$/;

/**
 * Parses `git blame --porcelain`: one entry per line of the file, in order, as
 * { commit, line, orig, path, text, start }. A commit's details come only the first time it appears,
 * so lines share one commit object. `start` marks the first line of a run from the same commit;
 * `path` is the file's name in that commit. Lines not committed yet have `commit.uncommitted`.
 */
export function parseBlame(raw) {
  const commits = new Map();
  const lines = [];
  let cur = null;
  let groupPath = null;
  for (const row of raw.split('\n')) {
    if (cur && row.startsWith('\t')) {
      const prev = lines.at(-1);
      lines.push({
        commit: cur.commit,
        line: cur.final,
        orig: cur.orig,
        path: groupPath ?? cur.commit.filename,
        text: row.slice(1).replace(/\r$/, ''),
        start: !prev || prev.commit !== cur.commit,
      });
      cur = null;
      continue;
    }
    const m = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/.exec(row);
    if (m && !cur) {
      let commit = commits.get(m[1]);
      if (!commit) {
        commit = { hash: m[1], author: '', time: 0, tz: '+0000', summary: '', filename: null, previous: null, boundary: false, uncommitted: ZERO_HASH.test(m[1]) };
        commits.set(m[1], commit);
      }
      // A group (the 4th number) names its file only when it differs; otherwise it's the commit's.
      if (m[4]) groupPath = null;
      cur = { commit, orig: Number(m[2]), final: Number(m[3]) };
      continue;
    }
    if (!cur) continue;
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const val = sp < 0 ? '' : row.slice(sp + 1);
    const c = cur.commit;
    if (key === 'author') c.author = val;
    else if (key === 'author-time') c.time = Number(val) || 0;
    else if (key === 'author-tz') c.tz = val;
    else if (key === 'summary') c.summary = val;
    else if (key === 'boundary') c.boundary = true;
    else if (key === 'previous') {
      const at = val.indexOf(' ');
      c.previous = { hash: val.slice(0, at), path: val.slice(at + 1) };
    } else if (key === 'filename') {
      c.filename ??= val;
      groupPath = val;
    }
  }
  return lines;
}

/** "2024-03-09": the day of a unix time in its own time zone ("+0100", "-0530"). */
export function isoDate(sec, tz = '+0000') {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(tz);
  const offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) : 0;
  return new Date((sec + offset) * 1000).toISOString().slice(0, 10);
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

/**
 * Reads "/find" arguments: `-S <text>` (commits that add or remove the text), `-G <regex>` (commits
 * whose changed lines match), or plain text (filters the loaded commits). The text is kept as typed,
 * spaces included; quotes around all of it are dropped.
 */
export function findArgs(text) {
  const s = (text ?? '').trim();
  const m = s.match(/^-([SG])(?:\s+|(?=\S)|$)([\s\S]*)$/);
  if (!m) return { mode: 'text', query: s };
  let query = m[2].trim();
  if (/^(["']).*\1$/.test(query) && query.length > 1) query = query.slice(1, -1);
  return { mode: m[1], query };
}

/** `git log` over the whole history (every branch and tag) for a -S or -G search, in LOG_FORMAT. */
export function searchArgs(mode, query) {
  return ['log', '--date-order', '--decorate=full', `-${mode}${query}`, `--format=${LOG_FORMAT}`, '--exclude=refs/stash', '--all'];
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
