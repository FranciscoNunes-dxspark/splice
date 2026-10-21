// /doctor: a health report of the repository, each finding with what to do about it, and an offer to do
// what Splice can. `readDoctor` gathers the facts in a handful of git processes (all at once where it can);
// `doctorFindings` (pure) decides what's worth saying, and `doctorText` lays it out for the viewer.
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from './git.js';
import { MB, bigFiles, blobIds, parseBatchCheck, parsePushLog, pushLogArgs } from './pushcheck.js';
import { checkGpgKey, needsPinentryCheck, signingConfig } from './signing.js';

const DAY = 24 * 60 * 60;
export const OLD_STASH_DAYS = 30;
export const BIG_UNTRACKED = 10 * MB;
export const BIG_COMMITTED = 10 * MB;
export const RECENT_COMMITS = 50;
// Stashes checked against HEAD: one git each.
const MAX_STASHES = 20;
const GC_AUTO = 6700;
const GC_PACKS = 50;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mb = (n) => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
const short = (hash) => hash.slice(0, 7);

/** The git versions the features Splice uses need. */
export const GIT_NEEDS = [
  { version: [2, 11], what: 'status --porcelain=v2, which Splice reads every change with' },
  { version: [2, 23], what: 'git switch and git restore, which Splice checks out, unstages and discards with' },
  { version: [2, 31], what: 'show --diff-merges=first-parent, which the graph shows a merge\'s files and diff with' },
  { version: [2, 36], what: 'worktree list -z, without which the Worktrees view shows no linked worktrees' },
];

/** "git version 2.45.1.windows.1" → [2, 45, 1], or null. */
export function parseGitVersion(raw) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const older = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** `git config --list -z` as key → its values in order (keys lowercased as git gives them; URLs in them kept). */
export function parseConfigList(raw) {
  const map = new Map();
  for (const entry of (raw ?? '').split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? 'true' : entry.slice(nl + 1);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

const last = (config, key) => config.get(key)?.at(-1) ?? null;
const isTrue = (v) => /^(true|yes|on|1)$/i.test(v ?? '');

/** The values a list setting ends up with: an empty one clears those before it, as git does for credential.helper. */
const listValue = (values = []) => values.slice(values.lastIndexOf('') + 1).filter(Boolean);

/** Whether a credential helper answers for `url`: credential.helper, or credential.<url>.helper for a prefix of it. */
export function hasCredentialHelper(config, url) {
  if (listValue(config.get('credential.helper')).length) return true;
  const u = url.toLowerCase();
  for (const [key, values] of config) {
    const m = /^credential\.(.+)\.helper$/.exec(key);
    if (!m || !listValue(values).length) continue;
    const scope = m[1].toLowerCase().replace(/\/$/, '');
    if (u.startsWith(scope) || u.replace(/^https?:\/\//, '').startsWith(scope.replace(/^https?:\/\//, ''))) return true;
  }
  return false;
}

/** `git count-objects -v` as { count, size (KiB), packs, sizePack (KiB) }. */
export function parseCountObjects(raw) {
  const out = { count: 0, size: 0, packs: 0, sizePack: 0 };
  for (const line of (raw ?? '').split('\n')) {
    const [k, v] = line.split(':').map((s) => s.trim());
    if (k === 'count') out.count = Number(v) || 0;
    else if (k === 'size') out.size = Number(v) || 0;
    else if (k === 'packs') out.packs = Number(v) || 0;
    else if (k === 'size-pack') out.sizePack = Number(v) || 0;
  }
  return out;
}

/** `git ls-files --eol -z`: [{ index, work, attr, path }], e.g. { index: 'crlf', work: 'crlf', attr: 'text=auto' }. */
export function parseEol(raw) {
  const out = [];
  for (const entry of (raw ?? '').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const m = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\s*$/.exec(entry.slice(0, tab));
    if (m) out.push({ index: m[1], work: m[2], attr: m[3], path: entry.slice(tab + 1) });
  }
  return out;
}

/** Whether a file's attributes ask git to keep LF in the repository: text, text=auto or an eol, not -text. */
const normalised = (attr) => !/(^|\s)-text(\s|$)/.test(attr) && /(^|\s)(text(=auto)?|eol=\w+)(\s|$)/.test(attr);

/** `git stash list -p --format=%x1e%gd`: [{ ref, patch }]. */
export function parseStashPatches(raw) {
  return (raw ?? '')
    .split('\x1e')
    .filter(Boolean)
    .map((rec) => {
      const nl = rec.indexOf('\n');
      return { ref: (nl < 0 ? rec : rec.slice(0, nl)).trim(), patch: nl < 0 ? '' : rec.slice(nl + 1).replace(/^\n+/, '') };
    })
    .filter((s) => s.ref);
}

/**
 * .gitignore lines for these paths: anchored at the root (so a leading # or ! is no longer special), with
 * wildcards and a trailing space escaped.
 */
export function ignoreLines(paths) {
  return paths.map((p) => `/${p.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ')}`);
}

/**
 * What's wrong with signing, for a repository that signs its commits (`cfg` from signing.js's signingConfig),
 * or null. `gpgError`: what checkGpgKey said, for OpenPGP; `keyFile`: { path, exists } for an SSH key given
 * as a file; `pinentry`: needsPinentryCheck's answer (no window to ask for a passphrase in).
 */
export function signingProblem(cfg, { gpgError = null, keyFile = null, pinentry = false } = {}) {
  if (!cfg.commits) return null;
  if (cfg.format === 'ssh') {
    if (!cfg.key) return 'commit.gpgsign is on with gpg.format ssh, but user.signingkey names no key';
    if (keyFile && !keyFile.exists) return `commit.gpgsign is on, but the SSH key it signs with, ${keyFile.path}, isn't there`;
    return null;
  }
  if (cfg.format !== 'openpgp' || !gpgError) return null;
  const program = cfg.program || 'gpg';
  if (/ENOENT|not recognized|command not found/i.test(gpgError)) return `commit.gpgsign is on, but ${program} isn't installed (or gpg.program doesn't point at it)`;
  if (/no secret key|secret key not available|unusable|no default secret key|skipped/i.test(gpgError)) {
    return `commit.gpgsign is on, but gpg has no usable secret key${cfg.key ? ` for ${cfg.key}` : ''}`;
  }
  if (/expired/i.test(gpgError)) return `commit.gpgsign is on, but the signing key${cfg.key ? ` ${cfg.key}` : ''} has expired`;
  // Locked: a pinentry with a window of its own asks for the passphrase when it's needed; without one, nothing can.
  if (pinentry) return "commit.gpgsign is on, but the key is locked, and there's no window here to ask for its passphrase in";
  return null;
}

/**
 * The findings, from the facts readDoctor gathers, most pressing first: { id, title, lines, fix, action }.
 * `action`, when Splice can do it, is { kind, label, ... } (see actions.js's doctor).
 */
export function doctorFindings(f) {
  const out = [];
  const add = (x) => out.push({ lines: [], action: null, ...x });
  const { branch = {}, state = null, now = Date.now() / 1000, platform = process.platform, config = new Map() } = f;

  if (f.gitVersion) {
    const missing = GIT_NEEDS.filter((n) => older(f.gitVersion, n.version));
    if (missing.length) {
      add({
        id: 'git',
        title: `Git ${f.gitVersion.join('.')} is older than Splice needs`,
        lines: missing.map((n) => `${n.version.join('.')}: ${n.what}`),
        fix: 'Update git (git-scm.com, or your package manager), then restart Splice.',
      });
    }
  }

  if (!branch.head && branch.oid && !state) {
    add({
      id: 'detached',
      title: `HEAD is detached at ${short(branch.oid)}`,
      lines: ['Commits made now belong to no branch, and are easy to lose once you switch away.'],
      fix: 'To keep working here, /branch <name> makes a branch at this commit; otherwise check out a branch (↵ in Branches).',
    });
  }

  if (f.signing) add({ id: 'signing', title: "Commits can't be signed", lines: [f.signing], fix: f.signingFix });

  const embedded = Object.entries(f.remoteUrls ?? {}).filter(([, url]) => /^https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(url));
  if (embedded.length) {
    add({
      id: 'url-password',
      title: `${embedded.length === 1 ? `The URL of ${embedded[0][0]} has` : `${embedded.length} remote URLs have`} a password or token in it`,
      lines: ['It sits in .git/config in plain text, where anything that reads the folder can find it.'],
      fix: 'Set the URL without it (u in /remote) and let a credential helper keep it, then change the token if it was ever shared.',
    });
  }

  const askpass = Boolean(f.env?.GIT_ASKPASS || last(config, 'core.askpass'));
  const https = Object.entries(f.remoteUrls ?? {}).filter(([, url]) => /^https?:\/\//i.test(url) && !hasCredentialHelper(config, url));
  if (https.length && !askpass) {
    const how =
      platform === 'win32'
        ? 'Git for Windows comes with Git Credential Manager: git config --global credential.helper manager'
        : platform === 'darwin'
          ? 'git config --global credential.helper osxkeychain (or install Git Credential Manager)'
          : 'install Git Credential Manager, or: git config --global credential.helper libsecret (cache keeps it in memory for a while instead)';
    add({
      id: 'credentials',
      title: `No credential helper for ${https.map(([name]) => name).join(', ')} (https)`,
      lines: ["Git runs without a terminal under Splice, so it can't ask for a user name and password: fetching and pushing over https fail."],
      fix: how,
    });
  }

  const pushed = (f.local ?? [])
    .filter((b) => !b.upstream)
    .map((b) => {
      const remotes = [...(f.remotes ?? [])].sort((a, c) => (a === 'origin' ? -1 : c === 'origin' ? 1 : 0));
      const r = remotes.find((x) => (f.remoteBranches ?? []).includes(`${x}/${b.name}`));
      return r ? { branch: b.name, upstream: `${r}/${b.name}` } : null;
    })
    .filter(Boolean);
  if (pushed.length) {
    add({
      id: 'upstream',
      title: `${plural(pushed.length, 'branch', 'branches')} pushed, but not tracking ${pushed.length === 1 ? 'it' : 'them'}`,
      lines: [...pushed.map((p) => `${p.branch}: ${p.upstream} is there`), "Without an upstream, p doesn't know what to pull, and ↑↓ don't show what's unpushed."],
      fix: 'Set each one\'s upstream (/upstream <branch> <remote/branch>).',
      action: { kind: 'upstream', label: `Set the upstream of ${plural(pushed.length, 'branch', 'branches')}`, items: pushed },
    });
  }

  const inHead = (f.stashes ?? []).filter((s) => s.inHead);
  if (inHead.length) {
    add({
      id: 'stash-in-head',
      title: `${plural(inHead.length, 'stash', 'stashes')} whose changes are already in HEAD`,
      lines: inHead.map((s) => `${s.ref}: ${s.message}`),
      fix: 'Nothing in them is missing from HEAD (untracked files they took aside), so they can go: x in Stash.',
      action: { kind: 'drop', label: `Drop the ${plural(inHead.length, 'stash', 'stashes')} already in HEAD`, refs: inHead.map((s) => s.ref), danger: true },
    });
  }
  const old = (f.stashes ?? []).filter((s) => !s.inHead && s.time && now - s.time > OLD_STASH_DAYS * DAY);
  if (old.length) {
    add({
      id: 'stash-old',
      title: `${plural(old.length, 'stash', 'stashes')} older than ${OLD_STASH_DAYS} days`,
      lines: old.map((s) => `${s.ref}: ${s.message} (${Math.floor((now - s.time) / DAY)} days)`),
      fix: 'Look at them in Stash (5): o pops one back, x drops one you no longer need.',
    });
  }

  const crlf = (f.eol ?? []).filter((e) => (e.index === 'crlf' || e.index === 'mixed') && normalised(e.attr));
  if (crlf.length) {
    add({
      id: 'eol',
      title: `${plural(crlf.length, 'file')} stored with CRLF though .gitattributes says to keep LF`,
      lines: [...crlf.slice(0, 8).map((e) => `${e.path} (${e.attr})`), ...(crlf.length > 8 ? [`and ${crlf.length - 8} more`] : [])],
      fix: 'Renormalise them (git add --renormalize .), then commit what that stages.',
      action: { kind: 'renormalize', label: 'Renormalise the line endings (git add --renormalize .)' },
    });
  }
  if (isTrue(last(config, 'core.autocrlf')) && platform !== 'win32') {
    add({
      id: 'autocrlf',
      title: 'core.autocrlf is true, which is meant for Windows',
      lines: ['Files are checked out with CRLF line endings here, which tools on this system may not expect.'],
      fix: 'git config --global core.autocrlf input (or false), or settle it for the repository in .gitattributes (* text=auto).',
    });
  }

  if (f.untracked?.length) {
    add({
      id: 'untracked-big',
      title: `${plural(f.untracked.length, 'untracked file')} over ${mb(BIG_UNTRACKED)}`,
      lines: f.untracked.map((u) => `${u.path}  ${mb(u.size)}`),
      fix: "Keep them out of git with .gitignore, or track them with Git LFS (git lfs track) if they belong in the repository.",
      action: { kind: 'ignore', label: `Add ${f.untracked.length === 1 ? 'it' : 'them'} to .gitignore`, paths: f.untracked.map((u) => u.path) },
    });
  }

  if (f.committed?.length) {
    add({
      id: 'committed-big',
      title: `${plural(f.committed.length, 'big file')} in the last ${RECENT_COMMITS} commits, not in Git LFS`,
      lines: f.committed.map((c) => `${c.path}  ${mb(c.size)}  in ${short(c.hash)} ${c.subject}`),
      fix: 'Track files like these with Git LFS (git lfs track). One not pushed yet can come out of its commit (z for the last one, i in the graph for an older one); once pushed, it stays in the history unless that is rewritten (git lfs migrate import).',
    });
  }

  if (f.objects) {
    const limit = Number(last(config, 'gc.auto') ?? GC_AUTO);
    const packLimit = Number(last(config, 'gc.autopacklimit') ?? GC_PACKS);
    const loose = f.objects.count > (limit > 0 ? limit : GC_AUTO);
    const packs = packLimit > 0 && f.objects.packs > packLimit;
    if (loose || packs) {
      add({
        id: 'gc',
        title: loose ? `${f.objects.count} loose objects (${mb(f.objects.size * 1024)})` : `${f.objects.packs} pack files`,
        lines: [
          limit > 0 ? `Git packs them by itself past gc.auto (${limit}), but hasn't yet; until it does, every command that reads objects is slower.` : 'gc.auto is 0, so git never packs them by itself.',
        ],
        fix: 'Pack them (git gc).',
        action: { kind: 'gc', label: 'Pack them now (git gc)' },
      });
    }
  }
  return out;
}

/** The report: each finding, numbered, what it means and what to do. */
export function doctorText(findings) {
  const out = [];
  findings.forEach((x, i) => {
    out.push(`${i + 1}. ${x.title}`, ...x.lines.map((l) => `   ${l}`), `   → ${x.fix}`, '');
  });
  const can = findings.filter((x) => x.action).length;
  if (can) out.push(`Splice can do ${can === findings.length ? (can === 1 ? 'that' : 'all of that') : `${can} of these`} for you: answer below.`);
  return out.join('\n').trimEnd();
}

const expand = (p) => (p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(2)) : p);

/**
 * Reads what doctorFindings needs. `data` is the loaded repository (refs, status, stashes, remotes, changes),
 * so only what it doesn't hold is asked: config, version, objects and the last commits at once, then the
 * line endings (only with attributes to check them against), the stashes against HEAD, and the blob sizes.
 */
export async function readDoctor({ root, gitDir, commonDir = gitDir, data, signal, platform = process.platform, env = process.env }) {
  const run = (args, opts) => git(root, args, { signal, ...opts });
  const quiet = (p) =>
    p.catch((e) => {
      if (e.cancelled) throw e;
      return '';
    });
  const stashes = data.stashes ?? [];
  const [configRaw, versionRaw, objectsRaw, logRaw, stashRaw] = await Promise.all([
    quiet(run(['config', '--list', '-z'])),
    quiet(run(['version'])),
    quiet(run(['count-objects', '-v'])),
    data.status.branch.oid ? quiet(run(pushLogArgs(['HEAD'], { patch: false, max: RECENT_COMMITS }))) : '',
    stashes.length ? quiet(run(['stash', 'list', '-p', '--binary', '--no-ext-diff', '--format=%x1e%gd'])) : '',
  ]);
  const config = parseConfigList(configRaw);
  const attributesFile = last(config, 'core.attributesfile');
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const attributes = [join(root, '.gitattributes'), join(commonDir, 'info', 'attributes'), join(xdg, 'git', 'attributes'), attributesFile && expand(attributesFile)].some(
    (p) => p && existsSync(p),
  );
  const commits = parsePushLog(logRaw);
  const ids = blobIds(commits);
  const patches = parseStashPatches(stashRaw).slice(0, MAX_STASHES).filter((s) => s.patch.trim());

  // A stash is in HEAD when its changes, taken back out, come out of HEAD cleanly: checked against an index of
  // HEAD of its own, so what's staged doesn't count.
  const inHead = new Set();
  const checkStashes = async () => {
    if (!patches.length || !data.status.branch.oid) return;
    const index = join(gitDir, 'splice-doctor-index');
    const indexEnv = { GIT_INDEX_FILE: index };
    try {
      await run(['read-tree', 'HEAD'], { env: indexEnv });
      for (const s of patches) {
        const ok = await run(['apply', '--check', '--reverse', '--cached', '-'], { env: indexEnv, input: s.patch.endsWith('\n') ? s.patch : `${s.patch}\n` }).then(
          () => true,
          (e) => {
            if (e.cancelled) throw e;
            return false;
          },
        );
        if (ok) inHead.add(s.ref);
      }
    } catch (e) {
      if (e.cancelled) throw e;
    } finally {
      await rm(index, { force: true }).catch(() => {});
    }
  };

  const cfg = signingConfig([...config].flatMap(([k, vs]) => vs.map((v) => `${k} ${v}`)).join('\n'));
  const checkSigning = async () => {
    if (!cfg.commits) return null;
    if (cfg.format === 'ssh') {
      const key = cfg.key ? expand(cfg.key) : null;
      const isFile = key && !/^key::|^ssh-|^ecdsa-|^sk-/.test(key);
      return signingProblem(cfg, { keyFile: isFile ? { path: cfg.key, exists: existsSync(resolve(root, key)) } : null });
    }
    if (cfg.format !== 'openpgp') return null;
    const gpgError = await checkGpgKey(cfg, { cwd: root }).then(() => null, (e) => e.message || String(e));
    return signingProblem(cfg, { gpgError, pinentry: needsPinentryCheck(cfg, { platform, env }) });
  };

  const untrackedSizes = async () => {
    const list = data.changes.unstaged.filter((c) => c.kind === 'untracked');
    const out = [];
    await Promise.all(
      list.map(async (c) => {
        const s = await stat(join(root, c.path)).catch(() => null);
        if (s?.isFile() && s.size > BIG_UNTRACKED) out.push({ path: c.path, size: s.size });
      }),
    );
    return out.sort((a, b) => b.size - a.size);
  };

  const [eolRaw, sizesRaw, signing, untracked] = await Promise.all([
    attributes ? quiet(run(['ls-files', '--eol', '-z'])) : '',
    ids.length ? quiet(run(['cat-file', '--batch-check'], { input: `${ids.join('\n')}\n` })) : '',
    checkSigning(),
    untrackedSizes(),
    checkStashes(),
  ]);
  return {
    branch: data.status.branch,
    state: data.state,
    platform,
    env,
    config,
    gitVersion: parseGitVersion(versionRaw),
    remotes: data.remotes,
    remoteUrls: data.remoteUrls,
    local: data.refs.local,
    remoteBranches: data.refs.remote.map((b) => b.name),
    stashes: stashes.map((s) => ({ ...s, inHead: inHead.has(s.ref) })),
    eol: parseEol(eolRaw),
    untracked,
    committed: bigFiles(commits, parseBatchCheck(sizesRaw), BIG_COMMITTED),
    objects: objectsRaw ? parseCountObjects(objectsRaw) : null,
    signing,
    signingFix:
      cfg.format === 'ssh'
        ? 'Point user.signingkey at your key (git config user.signingkey ~/.ssh/id_ed25519.pub) and add it to ssh-agent, or turn signing off: git config commit.gpgsign false'
        : 'Make or import a key (gpg --full-generate-key), set it with git config user.signingkey <id>, and unlock it once in a terminal; or turn signing off: git config commit.gpgsign false',
    now: Date.now() / 1000,
  };
}
