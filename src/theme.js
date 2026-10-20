// One palette for the whole UI. The accent can be changed in ~/.splice/config.json ("accent": "#hex").
export const theme = {
  accent: '#5fd787',
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  hunk: '#5fafd7',
  warn: '#ffd75f',
  local: '#5fafff',
  remote: '#af87ff',
  tag: '#ffd75f',
  gitMode: '#ff87d7',
  lanes: ['#5fafff', '#ff875f', '#5fd787', '#d787ff', '#ffd75f', '#5fd7d7', '#ff5f87', '#afd75f'],
};

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export function setAccent(color) {
  if (typeof color === 'string' && color) theme.accent = color;
}

/** Colour for a one-letter change code (M, A, D, R, ?, !). */
export function codeColor(code) {
  if (code === 'A' || code === '?') return theme.add;
  if (code === 'D' || code === '!') return theme.del;
  if (code === 'R' || code === 'C') return theme.local;
  return theme.warn;
}
