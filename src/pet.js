// Twig, Splice's beaver. One pixel drawing feeds the terminal pet, the SVG logo and the app icon.
// Beavers spend their lives joining branches together, which is roughly what a merge does.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Twig', kind: 'beaver' };

// The accent's family, as Trawl's Glim and Keel's Pinch are coloured from theirs: the accent for the
// outline, a darker and a paler shade, a near-black with its tint, and one contrasting colour.
export const PALETTE = {
  G: '#5fd787', // outline, the accent green
  D: '#2e8b57', // fur
  L: '#b4f0cc', // muzzle
  E: '#0e1a13', // eyes, nose
  W: '#ffffff', // eye shine
  T: '#ffb35f', // teeth, the one warm colour: a beaver's really are orange
};

// 16 × 10 pixels; '.' is transparent. The head is columns 0–13; 14–15 are room for a waving paw.
// A flat-topped head with small ears low on its sides, round cheeks, a dark nose on a pale muzzle,
// and the front teeth showing below the chin: a beaver.
const BASE = [
  '...GGGGGGGG.....',
  '.GGDDDDDDDDGG...',
  'GDGDDDDDDDDGDG..',
  'GGDEWDDDDEWDGG..',
  '.GDEEDDDDEEDG...',
  'GDDDDLEELDDDDG..',
  'GDDDLLLLLLDDDG..',
  'GDDLLLLLLLLDDG..',
  '.GDDLLTTLLDDG...',
  '..GGGGTTGGGG....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: 'GGDWEDDDDWEDGG..' }, // glancing the other way, for the busy animation
  sleep: { 3: 'GGDDDDDDDDDDGG..', 4: '.GDEEDDDDEEDG...' },
  happy: { 3: 'GGDEDDDDDDEDGG..', 4: '.GEDEDDDDEDEG...' },
  worried: { 3: 'GGDWWDDDDWWDGG..', 4: '.GDEEDDDDEEDG...' },
  wave: { 1: '.GGDDDDDDDDGG.GG', 2: 'GDGDDDDDDDDGDGDG', 3: 'GGDEWDDDDEWDGGDG', 4: '.GDEEDDDDEEDG.G.' },
};

/** The drawing for a mood, as rows of palette letters. */
export function petPixels(mood = 'idle') {
  const over = MOODS[mood] ?? {};
  return BASE.map((row, i) => over[i] ?? row);
}

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function petRows(mood = 'idle') {
  const px = petPixels(mood);
  const rows = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs = [];
    for (let x = 0; x < px[y].length; x++) {
      const top = PALETTE[px[y][x]];
      const bottom = PALETTE[px[y + 1]?.[x]];
      if (top && bottom) segs.push({ text: '▀', color: top, bg: bottom });
      else if (top) segs.push({ text: '▀', color: top });
      else if (bottom) segs.push({ text: '▄', color: bottom });
      else segs.push({ text: ' ' });
    }
    rows.push(segs);
  }
  return rows;
}

/** A one-line face for the header: Π is the two front teeth. */
export const FACES = {
  idle: '(•Π•)',
  look: '(•Π•)',
  sleep: '(–Π–)',
  happy: '(^Π^)',
  worried: '(◉Π◉)',
  wave: '(•Π•)/',
};

/** How the pet feels about the repository right now. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if ((data?.state && data.state !== 'bisecting') || data?.changes.conflicts.length) return 'worried';
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  if (data.status.branch.ahead) return 'wave';
  return data.status.files.length ? 'idle' : 'sleep';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `Pick a repository and ${PET.name} will keep an eye on it.`;
  const n = data.status.files.length;
  const ahead = data.status.branch.ahead;
  if (mood === 'worried') return 'Something needs you: there are conflicts to sort out.';
  if (mood === 'wave') return `${ahead} commit${ahead === 1 ? '' : 's'} waiting to be pushed. ${PET.name} is waving them off.`;
  if (mood === 'sleep') return `Everything is committed, so ${PET.name} is having a nap.`;
  return `${n} change${n === 1 ? '' : 's'} in the working tree.`;
}
