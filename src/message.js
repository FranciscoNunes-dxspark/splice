// Commit messages in a file, for writing in your own editor (Splice never opens one): what goes in the
// file, and what git will make of it. Pure, for tests; actions.js reads and writes the file.

const WORDS = { M: 'modified', A: 'new file', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };
const MAX_FILES = 200;

/** The character git strips lines with (--cleanup=strip): `core.commentChar` as set, "#" when unset or "auto". */
export function commentChar(setting) {
  const c = String(setting ?? '').trim();
  return c && c !== 'auto' ? c : '#';
}

/**
 * The message file: `message` (empty for you to write), then lines starting with `comment` saying how
 * to use it and listing `files` ({ code, path, orig }: what's staged, or for an amend what the commit
 * will hold), which git leaves out.
 */
export function messageFileText({ message = '', files = [], amend = false, comment = '#' } = {}) {
  const c = comment;
  const text = message.replace(/\r\n/g, '\n').trimEnd();
  // An empty first line to write on, else the message and a blank line.
  const out = text ? [text, ''] : [''];
  out.push(`${c} The ${amend ? "amended commit's" : 'commit'} message: the subject on the first line, then a blank line and the body.`);
  out.push(`${c} Lines starting with ${c} are left out. Save the file, then press enter in Splice to ${amend ? 'amend' : 'commit'}.`);
  out.push(c);
  if (files.length) {
    out.push(`${c} ${amend ? 'In the amended commit' : 'Changes to be committed'}:`);
    for (const f of files.slice(0, MAX_FILES)) {
      const word = `${WORDS[f.code] ?? 'changed'}:`.padEnd(12);
      out.push(`${c}\t${word}${f.orig ? `${f.orig} -> ${f.path}` : f.path}`);
    }
    if (files.length > MAX_FILES) out.push(`${c}\t… and ${files.length - MAX_FILES} more`);
  } else {
    out.push(`${c} Nothing is staged yet: committing offers to stage all your changes.`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * The message git takes from a message file with --cleanup=strip: without the comment lines and
 * trailing spaces, runs of blank lines made one, and none at the start or end. Empty means no message.
 */
export function readMessage(text, comment = '#') {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith(comment))
    .map((l) => l.trimEnd());
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What's typed in the prompt, as a start for the message file: { amend, message } for "/commit <text>"
 * or "/amend <text>" (\n for a line break, as the commands take it), else an empty commit message.
 */
export function promptMessage(value) {
  const m = /^\/(commit|amend)(?:\s+([\s\S]*))?$/.exec(String(value ?? '').trim());
  if (!m) return { amend: false, message: '' };
  const text = (m[2] ?? '').trim();
  return { amend: m[1] === 'amend', message: /^--file(\s|$)/.test(text) ? '' : text.replace(/\\n/g, '\n') };
}
