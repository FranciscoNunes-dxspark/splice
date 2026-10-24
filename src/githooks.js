// Git hooks: which ones are active, what manages them, and how to run one by hand. Pure: repo.js's
// readHooks looks at the files, and actions.js runs them through git (no terminal, nothing on stdin).

/** The hooks git runs on this side (githooks(5)), in the order a commit, then a push, meets them. */
export const KNOWN_HOOKS = [
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-rebase',
  'post-rewrite',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
  'reference-transaction',
  'push-to-checkout',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
];

/** The hooks `git commit --no-verify` skips, and `git push --no-verify`. */
export const COMMIT_HOOKS = ['pre-commit', 'commit-msg'];
export const PUSH_HOOKS = ['pre-push'];

/** git hook run arrived in 2.36; before it, Splice runs the file itself, through a git alias. */
export const HOOK_RUN_GIT = [2, 36];

/** Husky 9 points core.hooksPath at .husky/_, where every hook is the same runner of .husky/<name>. */
export const isHuskyRunner = (dir) => /(^|[\\/])\.husky[\\/]_[\\/]?$/.test(String(dir ?? ''));

/** What manages a hook, from its first lines: husky, lefthook or pre-commit, else null (your own script). */
export function frameworkIn(text) {
  const s = String(text ?? '');
  if (/husky/i.test(s)) return 'husky';
  if (/lefthook/i.test(s)) return 'lefthook';
  if (/pre-commit\.com|from pre_commit|pre-commit run|INSTALL_PYTHON|hook-impl/i.test(s)) return 'pre-commit';
  return null;
}

/** The framework config files looked for at the top of the repository, by framework. */
export const FRAMEWORK_FILES = {
  lefthook: ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'],
  'pre-commit': ['.pre-commit-config.yaml', '.pre-commit-config.yml'],
};

/** The hooks a lefthook.yml sets up: its top-level keys that are hook names. */
export function lefthookHooks(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([a-z][\w-]*)\s*:/.exec(line);
    if (m && KNOWN_HOOKS.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The hooks a .pre-commit-config.yaml installs: its default_install_hook_types (a [list] or "- item" lines),
 * else just pre-commit.
 */
export function preCommitHooks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^default_install_hook_types\s*:/.test(l));
  if (i < 0) return ['pre-commit'];
  const inline = /:\s*\[(.*)\]/.exec(lines[i]);
  const names = [];
  if (inline) names.push(...inline[1].split(','));
  else {
    for (const l of lines.slice(i + 1)) {
      if (/^\s*-/.test(l)) names.push(l.replace(/^\s*-\s*/, ''));
      else if (l.trim()) break;
    }
  }
  const out = names.map((n) => n.trim().replace(/^["']|["']$/g, '')).filter((n) => KNOWN_HOOKS.includes(n));
  return out.length ? out : ['pre-commit'];
}

/**
 * The arguments git would give a hook run by hand: a message file for the commit message hooks, the
 * remote and its URL for pre-push, HEAD twice and a branch switch for post-checkout, a plain merge for
 * post-merge; nothing for the rest.
 */
export function hookArgs(name, { messageFile, remote, url } = {}) {
  if (name === 'commit-msg' || name === 'prepare-commit-msg' || name === 'applypatch-msg') return messageFile ? [messageFile] : [];
  if (name === 'pre-push') return remote ? [remote, url ?? remote] : [];
  if (name === 'post-checkout') return ['HEAD', 'HEAD', '1'];
  if (name === 'post-merge') return ['0'];
  return [];
}

const atLeast = (v, min) => Boolean(v) && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));

/**
 * The git arguments that run hook `name` (its file `file`) now: `git hook run` on git 2.36 and later, which
 * finds it as a commit would; before that, the file itself through a git alias, so git's own shell runs it
 * (Git for Windows' sh too) from the top of the working tree.
 */
export function hookRunArgs(name, file, version, args = []) {
  if (atLeast(version, HOOK_RUN_GIT)) return ['hook', 'run', '--ignore-missing', name, '--', ...args];
  const path = String(file).replace(/\\/g, '/').replace(/(["\\$`])/g, '\\$1');
  return ['-c', `alias.splice-run-hook=!"${path}"`, 'splice-run-hook', ...args];
}

/** Whether any of `names` is an active hook in `hooks` (readHooks's). */
export const hasHook = (hooks, names) => Boolean(hooks?.hooks.some((h) => names.includes(h.name)));

/** /hooks' rows, as text for one line each: [{ hook | framework, label, detail }]. */
export function hookRows(hooks) {
  const rows = hooks.hooks.map((h) => ({
    hook: h,
    label: h.name,
    detail: `${h.shown}${h.framework ? `  (${h.framework})` : ''}`,
  }));
  for (const f of hooks.frameworks) {
    const missing = f.hooks.filter((n) => !hooks.hooks.some((h) => h.name === n));
    rows.push({
      framework: f,
      label: f.name,
      detail: `${f.file}: ${f.hooks.join(', ') || 'no hooks'}${missing.length ? `  · not installed: ${missing.join(', ')} (${f.name === 'lefthook' ? 'lefthook install' : 'pre-commit install'})` : ''}`,
    });
  }
  return rows;
}
