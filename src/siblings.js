// Splice's side of the family (family.js, the kit the sibling apps share): what this repository offers
// them (/family), the paste that opens the prompt, and Twig's mood told to the others and theirs read
// back. Pure: actions.js and App.jsx do the copying, the reading and the writing.
import { decodeContext, shareLine } from './family.js';

/** The siblings' mascots, by app, for "Ping says: …". */
export const MASCOTS = { trawl: 'Glim', sonar: 'Ping', bosun: 'Squawk', hail: 'Hoot', splice: 'Twig' };
/** The apps' names as they're written. */
export const APP_NAMES = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };

/**
 * What a paste (or anything typed at once, more than one character) that should go into the prompt
 * rather than to the view is: a command line starting with /, or a context another app copied. The text
 * without the terminal's paste brackets and the newline at its end; null for anything else (a key, a
 * line of several, a drop, which the caller tells apart first).
 */
export function pastedLine(input) {
  const s = String(input ?? '').replace(/\x1b\[20[01]~/g, '').replace(/[\r\n]+$/, '');
  if (s.length < 2 || /[\r\n]/.test(s)) return null;
  const t = s.trim();
  return t.startsWith('/') || decodeContext(t) ? t : null;
}

const isEnvName = (s) => /^[A-Z0-9_]+$/.test(s);

/**
 * The line that opens a database in Trawl: `/azure-sql <server> [database]` for Azure SQL without a
 * login (Trawl signs in through az), else `/add <name> <server> [database] [--kind …] [--user …]`.
 * Never the password: Trawl asks for it once, and keeps it in the OS's credential store.
 */
export function trawlLine(db, repoName) {
  const server = db.port ? `${db.server}${db.kind === 'sqlserver' ? ',' : ':'}${db.port}` : db.server;
  if (db.kind === 'sqlserver' && /\.database\.windows\.net$/i.test(db.server) && !db.user) return shareLine('azure-sql', [db.server, ...(db.database ? [db.database] : [])]);
  const name = isEnvName(db.name) ? (db.database ?? repoName) : db.name;
  return shareLine('add', [name, server, ...(db.database ? [db.database] : []), ...(db.kind !== 'sqlserver' ? ['--kind', db.kind] : []), ...(db.user ? ['--user', db.user] : [])]);
}

/**
 * What the repository offers the siblings (family.js's projectAt of its root), as /family lists it:
 * [{ app, line, what }]. Bosun runs it when it has a crew; Hail opens each .http file; Trawl each
 * database its settings name. Sonar finds nothing in a checkout it could take for sure, so it gets nothing.
 */
export function familyOffers(project, repoName) {
  const out = [];
  if (project.crew) out.push({ app: 'Bosun', line: shareLine('move', [project.dir]), what: 'run its processes' });
  for (const f of project.httpFiles) out.push({ app: 'Hail', line: shareLine('open', [f]), what: 'send its requests' });
  for (const db of project.databases) out.push({ app: 'Trawl', line: trawlLine(db, repoName), what: `${db.name}, from ${db.source}` });
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Twig's mood (pet.js's moodFor) as the family says moods: { mood: happy | worried | sad | busy | neutral,
 * reason }. `busy` is the running command, `lastEntry` the activity log's last line.
 */
export function familyMood(petMood, { data, lastEntry, busy } = {}) {
  if (petMood === 'worried') {
    const n = data?.changes?.conflicts?.length ?? 0;
    if (n) return { mood: 'worried', reason: `${plural(n, 'conflict')} in ${data.name}` };
    if (data?.state && data.state !== 'bisecting') return { mood: 'worried', reason: `${data.name} is stopped ${data.state}` };
    return { mood: 'worried', reason: lastEntry?.title ? `${lastEntry.title} failed` : '' };
  }
  if (petMood === 'look') return { mood: 'busy', reason: busy?.label ?? '' };
  if (petMood === 'happy') return { mood: 'happy', reason: lastEntry?.title ? `${lastEntry.title} went through` : '' };
  const ahead = data?.status?.branch?.ahead ?? 0;
  if (petMood === 'wave') return { mood: 'neutral', reason: `${plural(ahead, 'commit')} to push` };
  if (petMood === 'sleep') return { mood: 'neutral', reason: 'everything committed' };
  return { mood: 'neutral', reason: '' };
}

/** The others' moods worth a word (worried, sad or happy) and not shown yet (`seen`: "app:at"), newest first. */
export const moodsToShow = (moods, seen) => moods.filter((m) => ['worried', 'sad', 'happy'].includes(m.mood) && !seen.has(`${m.app}:${m.at}`));

/** "Ping says: production has 12 new exceptions", or "Ping looks worried" without a reason. */
export function reactionText(m) {
  const who = MASCOTS[m.app] ?? APP_NAMES[m.app] ?? m.app;
  return m.reason ? `${who} says: ${m.reason}` : `${who} looks ${m.mood}`;
}
