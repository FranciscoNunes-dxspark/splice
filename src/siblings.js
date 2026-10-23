// Splice's side of the family (family.js, the kit the sibling apps share, has the names, the paste rule
// and Trawl's lines): what this repository offers them (/family), and Twig's mood told to the others and
// theirs read back. Pure: actions.js and App.jsx do the copying, the reading and the writing.
import { APP_NAMES, PET_NAMES, shareLine, trawlLine } from './family.js';

const isEnvName = (s) => /^[A-Z0-9_]+$/.test(s);

/**
 * The name Trawl keeps a database under: its settings' key, unless that's an environment variable's
 * (DATABASE_URL), when the database's name (else the repository's) says more.
 */
export const trawlName = (db, repoName) => (isEnvName(db.name) ? (db.database ?? repoName) : db.name);

/**
 * What the repository offers the siblings (family.js's projectAt of its root), as /family lists it:
 * [{ app, line, what }]. Bosun runs it when it has a crew; Hail opens each .http file; Trawl each
 * database its settings name. Sonar finds nothing in a checkout it could take for sure, so it gets nothing.
 */
export function familyOffers(project, repoName) {
  const out = [];
  if (project.crew) out.push({ app: 'bosun', line: shareLine('move', [project.dir]), what: 'run its processes' });
  for (const f of project.httpFiles) out.push({ app: 'hail', line: shareLine('open', [f]), what: 'send its requests' });
  for (const db of project.databases) out.push({ app: 'trawl', line: trawlLine(db, trawlName(db, repoName)), what: `${db.name}, from ${db.source}` });
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
  const who = PET_NAMES[m.app] ?? APP_NAMES[m.app] ?? m.app;
  return m.reason ? `${who} says: ${m.reason}` : `${who} looks ${m.mood}`;
}
