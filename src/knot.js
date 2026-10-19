// Knot, Tiller's otter. One pixel drawing feeds the terminal pet, the SVG logo and the app icon.
// Otters hold hands while they sleep so they don't drift apart, which is roughly what a merge does.

export const PALETTE = {
  G: '#5fd787', // outline, the accent green
  D: '#2e8b57', // fur
  L: '#b4f0cc', // muzzle
  E: '#0e1a13', // eyes, nose, mouth
  W: '#ffffff', // eye shine
};

// 16 × 10 pixels; '.' is transparent. The head is columns 0–13; 14–15 are room for a waving paw.
// A wide flat head, small ears far apart, and a big pale muzzle with the nose on top: an otter.
const BASE = [
  '..GG......GG....',
  '.GDDGGGGGGDDG...',
  'GDDDDDDDDDDDDG..',
  'GDDEWDDDDEWDDG..',
  'GDDEEDDDDEEDDG..',
  'GDDLLLEELLLDDG..',
  'GDLLLLEELLLLDG..',
  'GDLLLELLELLLDG..',
  '.GDLLLLLLLLDG...',
  '..GGGGGGGGGG....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: 'GDDWEDDDDWEDDG..' }, // glancing the other way, for the busy animation
  sleep: { 3: 'GDDDDDDDDDDDDG..', 4: 'GDDEEDDDDEEDDG..' },
  happy: { 3: 'GDDEDDDDDDEDDG..', 4: 'GDEDEDDDDEDEDG..' },
  worried: { 3: 'GDDWWDDDDWWDDG..', 4: 'GDDEEDDDDEEDDG..', 7: 'GDLLLEEEELLLDG..' },
  wave: { 1: '.GDDGGGGGGDDG.GG', 2: 'GDDDDDDDDDDDDGDG', 3: 'GDDEWDDDDEWDDGDG', 4: 'GDDEEDDDDEEDDGG.' },
};

/** The drawing for a mood, as rows of palette letters. */
export function knotPixels(mood = 'idle') {
  const over = MOODS[mood] ?? {};
  return BASE.map((row, i) => over[i] ?? row);
}

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function knotRows(mood = 'idle') {
  const px = knotPixels(mood);
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

/** A one-line face for the header. */
export const FACES = {
  idle: '(•ω•)',
  look: '(•ω•)',
  sleep: '(–ω–)',
  happy: '(^ω^)',
  worried: '(◉ω◉)',
  wave: '(•ω•)/',
};

/** How Knot feels about the repository right now. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (data?.state || data?.changes.conflicts.length) return 'worried';
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  if (data.status.branch.ahead) return 'wave';
  return data.status.files.length ? 'idle' : 'sleep';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return 'Pick a repository and Knot will keep an eye on it.';
  const n = data.status.files.length;
  const ahead = data.status.branch.ahead;
  if (mood === 'worried') return 'Something needs you: there are conflicts to sort out.';
  if (mood === 'wave') return `${ahead} commit${ahead === 1 ? '' : 's'} waiting to be pushed. Knot is waving them off.`;
  if (mood === 'sleep') return 'Everything is committed, so Knot is having a nap.';
  return `${n} change${n === 1 ? '' : 's'} in the working tree.`;
}
