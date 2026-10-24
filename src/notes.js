// Git notes (refs/notes/commits): what /note was asked to do, and the old notes it keeps so a change can
// be taken back. Pure: actions.js runs git notes and writes the copies.

/** /note's text: { remove } for -d, { undo } for --undo, { text } (\n a line break), or {} alone. */
export function noteArgs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return {};
  if (s === '-d' || s === '--delete' || s === '--remove') return { remove: true };
  if (s === '--undo') return { undo: true };
  return { text: s.replace(/\\n/g, '\n') };
}

/** The prompt line that edits `note`: its line breaks as \n, as /note reads them back. */
export const notePrefill = (note) => `/note ${String(note ?? '').trimEnd().replace(/\r?\n/g, '\\n')}`;

/** The kept notes with `entry` ({ hash, note, at }) added last, the newest `max` of them. */
export const withKeptNote = (list, entry, max = 10) => [...(Array.isArray(list) ? list : []), entry].slice(-max);

/** /notes' arguments: { push: true, remote } for `push [remote]`, else { error }. */
export function notesArgs(raw) {
  const [how, remote, ...extra] = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (how !== 'push' || extra.length) return { error: 'Use: /notes push [remote]' };
  return { push: true, remote: remote ?? null };
}

/** The refspec that pushes every notes ref, as git keeps them. */
export const NOTES_REFSPEC = 'refs/notes/*:refs/notes/*';
