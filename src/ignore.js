// Ignoring untracked files from Changes (i, /ignore): what to offer for a path, and the line to add to a
// .gitignore without disturbing the rest of it. Pure.
import { posix } from 'node:path';

/**
 * A path written so .gitignore matches it literally: wildcards and backslashes escaped, as are a
 * leading # or ! (a comment, a negation) and trailing spaces (which git would drop).
 */
export function escapeIgnore(path) {
  let s = path.replace(/[\\*?[]/g, (c) => `\\${c}`);
  if (/^[#!]/.test(s)) s = `\\${s}`;
  return s.replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
}

/**
 * What i offers for the untracked `path` (relative to the repository, / separated; a folder ends in /):
 * the file itself, its folder, every file with its extension, and, for a path in a subfolder, the file
 * in that folder's own .gitignore. Each is { label, file (the .gitignore, relative to the root), pattern }.
 * Paths are anchored with a leading /, so they match there and nowhere else.
 */
export function ignoreChoices(path) {
  const folder = path.endsWith('/');
  const bare = folder ? path.slice(0, -1) : path;
  const dir = posix.dirname(bare);
  const name = posix.basename(bare);
  const out = [{ label: `This ${folder ? 'folder' : 'file'}: /${bare}${folder ? '/' : ''}`, file: '.gitignore', pattern: `/${escapeIgnore(bare)}${folder ? '/' : ''}` }];
  if (dir !== '.') out.push({ label: `Its folder: /${dir}/`, file: '.gitignore', pattern: `/${escapeIgnore(dir)}/` });
  const ext = folder ? '' : (name.match(/^.+\.([^.]+)$/)?.[1] ?? '');
  if (ext) out.push({ label: `Every *.${ext} file, in any folder`, file: '.gitignore', pattern: `*.${escapeIgnore(ext)}` });
  if (dir !== '.') out.push({ label: `This ${folder ? 'folder' : 'file'}, in ${dir}/.gitignore: /${name}${folder ? '/' : ''}`, file: `${dir}/.gitignore`, pattern: `/${escapeIgnore(name)}${folder ? '/' : ''}` });
  return out;
}

/**
 * `text` (a .gitignore's contents, '' for a new one) with `pattern` added as its last line, in the
 * file's own line endings and ending in one. `added` is false when the file has that line already.
 */
export function withIgnoreLine(text, pattern) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.includes(pattern)) return { text, added: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text && !text.endsWith('\n') ? text + eol : text;
  return { text: `${body}${pattern}${eol}`, added: true };
}
