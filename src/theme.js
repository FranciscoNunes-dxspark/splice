// One palette for the whole UI. The accent can be changed in /settings (it's "accent": "#hex" in the config).
export const theme = {
  accent: '#5fd787', // DEFAULT_ACCENT, below
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

export const DEFAULT_ACCENT = '#5fd787';

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** Sets the accent; anything that isn't a colour (no setting, say) puts the default back. */
export function setAccent(color) {
  theme.accent = isColour(color) ? color : DEFAULT_ACCENT;
}

/** Colour for a one-letter change code (M, A, D, R, ?, !). */
export function codeColor(code) {
  if (code === 'A' || code === '?') return theme.add;
  if (code === 'D' || code === '!') return theme.del;
  if (code === 'R' || code === 'C') return theme.local;
  return theme.warn;
}
