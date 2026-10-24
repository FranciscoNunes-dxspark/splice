// Files and folders dropped on the terminal, which types their paths. Pure: actions.js's openDropped
// looks at what they are. The parsing is Trawl's (consoles.js), for any path rather than only .sql files.
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The paths in what a terminal types when files or folders are dropped on it: absolute paths separated
 * by spaces, quoted when they have spaces in them (or, outside Windows, with a \ before each), or as
 * file:// URLs. Null when `text` is anything else, which is then just typing.
 */
export function droppedPaths(text, { windows = process.platform === 'win32' } = {}) {
  const s = String(text ?? '').trim();
  if (!s || /[\r\n]/.test(s)) return null;
  const token = windows ? /"([^"]*)"|'([^']*)'|(\S+)/g : /"([^"]*)"|'([^']*)'|((?:\\.|\S)+)/g;
  // A name after the root, so two slashes typed at once (or a lone drive) aren't taken for a drop.
  const absolute = windows ? /^(?:[a-z]:[\\/][^\\/]|\\\\[^\\/])/i : /^\/[^/]/;
  const paths = [];
  for (const [, double, single, bare] of s.matchAll(token)) {
    let path = double ?? single ?? (windows ? bare : bare.replace(/\\(.)/g, '$1'));
    if (/^file:\/\//i.test(path)) {
      try {
        path = fileURLToPath(path, { windows });
      } catch {
        return null;
      }
    }
    if (!absolute.test(path)) return null;
    // A folder dropped from some file managers ends in a separator.
    paths.push(path.length > 3 ? path.replace(windows ? /[\\/]+$/ : /\/+$/, '') : path);
  }
  return paths.length ? paths : null;
}

/** `path` relative to the repository at `root` (with / between folders), or null when it's outside it. */
export function insideRepo(root, path, { windows = process.platform === 'win32' } = {}) {
  const p = windows ? win32 : posix;
  const rel = p.relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

export { pathArg } from './family.js';
