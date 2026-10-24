// Sparse checkout: which part of the repository the working tree holds. Pure: repo.js reads the files git
// keeps it in (the config's core.sparseCheckout and core.sparseCheckoutCone, the worktree's own
// config.worktree, and info/sparse-checkout) on each load, so polling never asks git about it.

const TRUE = /^(true|yes|on|1)$/i;

/**
 * A boolean from a git config file's text: `section.key` as the file sets it last, or null when it isn't
 * set. Enough of the format for core's flags: [section] headers, `key = value` or a bare `key`, comments.
 */
export function configFlag(text, section, key) {
  let inSection = false;
  let value = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim();
    if (!line) continue;
    const head = /^\[\s*([^\s\]"]+)(?:\s+"[^"]*")?\s*\]\s*(.*)$/.exec(line);
    if (head) {
      inSection = head[1].toLowerCase() === section.toLowerCase();
      if (!head[2]) continue;
    }
    if (!inSection) continue;
    const m = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(head ? head[2] : line);
    if (m && m[1].toLowerCase() === key.toLowerCase()) value = m[2] === undefined ? true : TRUE.test(m[2].trim().replace(/^"|"$/g, ''));
  }
  return value;
}

const unescape = (s) => s.replace(/\\(.)/g, '$1');

/** The patterns of an info/sparse-checkout file, comments and blank lines left out. */
export const sparsePatterns = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/** Whether the patterns are the shape cone mode writes: everything at the top, then folders. */
export const looksCone = (patterns) => patterns[0] === '/*' && patterns[1] === '!/*/';

/**
 * The folders a cone-mode file checks out whole, as `git sparse-checkout list` shows them: each `/dir/`
 * that isn't followed by `!/dir/*\/` (which makes it a parent, of which only the files directly in it are).
 */
export function coneFolders(patterns) {
  const parents = new Set(patterns.filter((p) => /^!\/.+\/\*\/$/.test(p)).map((p) => p.slice(1, -2)));
  return patterns
    .filter((p) => /^\/.+\/$/.test(p) && p !== '/*/' && !parents.has(p))
    .map((p) => unescape(p.slice(1, -1)));
}

/**
 * The working tree's sparse checkout, from the three files' text: { on, cone, folders, patterns }, where
 * `folders` are cone mode's folders and `patterns` the file's lines (what non-cone mode goes by).
 */
export function sparseState({ config = '', worktreeConfig = '', file = '' } = {}) {
  const flag = (key) => configFlag(worktreeConfig, 'core', key) ?? configFlag(config, 'core', key);
  const patterns = sparsePatterns(file);
  const on = flag('sparseCheckout') === true;
  const cone = flag('sparseCheckoutCone') ?? looksCone(patterns);
  return { on, cone: on && cone, folders: on && cone ? coneFolders(patterns) : [], patterns: on ? patterns : [] };
}

const clean = (dir) => String(dir).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

/**
 * Whether cone mode with `folders` keeps `path` in the working tree: a file at the top, anything in one of
 * the folders, or a file directly in a folder above one of them.
 */
export function inCone(path, folders) {
  const p = clean(path);
  const slash = p.lastIndexOf('/');
  if (slash < 0) return true;
  const parent = p.slice(0, slash);
  return folders.map(clean).some((f) => p.startsWith(`${f}/`) || f === parent || f.startsWith(`${parent}/`));
}

/** The folders that go when cone mode's `from` becomes `to`: each in `from` that no folder in `to` holds. */
export const leavingFolders = (from, to) => from.map(clean).filter((f) => !to.map(clean).some((t) => f === t || f.startsWith(`${t}/`)));

/** Changed files (status's, with `path`) that cone mode with `folders` would leave out of the working tree. */
export const changedOutside = (files, folders) => files.filter((f) => !inCone(f.path, folders));

/** /sparse alone: what the viewer says. */
export function sparseText(state) {
  if (!state.on) return 'Sparse checkout is off: the working tree has every file.\n\n/sparse set <folder…> checks out only those folders (and the files at the top).';
  const lines = [`Sparse checkout is on, ${state.cone ? 'in cone mode' : 'with patterns (not cone mode)'}.`, ''];
  if (state.cone) {
    if (state.folders.length) lines.push('Folders checked out, with everything in them:', ...state.folders.map((f) => `  ${f}/`));
    else lines.push('Only the files at the top of the repository are checked out.');
    lines.push('', 'The files at the top, and those directly in the folders above these, are checked out too.');
  } else {
    lines.push('Patterns (info/sparse-checkout):', ...state.patterns.map((p) => `  ${p}`));
  }
  lines.push('', '/sparse add <folder…> brings more back (alone: pick one) · /sparse set <folder…> replaces them · /sparse off checks out everything.');
  return lines.join('\n');
}
