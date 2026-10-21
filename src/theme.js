// One palette for the whole UI, dark or light (the Theme setting: "theme": "dark" | "light" | "auto"
// in the config). The accent can be changed too, in /settings ("accent": "#hex"). Everything on
// screen takes its colours from `theme`, read as it draws, so applyTheme repaints the next frame.
export const DARK = {
  accent: '#5fd787', // DEFAULT_ACCENT, below
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  // Behind the words a diff line changed.
  addWord: '#1f5f2f',
  delWord: '#6f1f1f',
  // Behind search matches in the viewer, and the current one.
  match: '#5f5f00',
  matchHere: '#af8700',
  hunk: '#5fafd7',
  warn: '#ffd75f',
  local: '#5fafff',
  remote: '#af87ff',
  tag: '#ffd75f',
  bangMode: '#ff87d7',
  lanes: ['#5fafff', '#ff875f', '#5fd787', '#d787ff', '#ffd75f', '#5fd7d7', '#ff5f87', '#afd75f'],
};

// For a white (or pale) background: darker inks, pale backgrounds behind words and matches, white
// on the coloured bars.
export const LIGHT = {
  accent: '#00875f', // LIGHT_ACCENT, below
  border: '#a8a8a8',
  dim: '#6c6c6c',
  selBg: '#e4e4e4',
  ink: '#ffffff',
  add: '#008700',
  del: '#d70000',
  addWord: '#c6efc6',
  delWord: '#f7cfcf',
  match: '#ffff87',
  matchHere: '#ffaf00',
  hunk: '#005f87',
  warn: '#af5f00',
  local: '#005fd7',
  remote: '#8700af',
  tag: '#af5f00',
  bangMode: '#d7005f',
  lanes: ['#005fd7', '#d75f00', '#00875f', '#8700af', '#af8700', '#008787', '#d7005f', '#5f8700'],
};

export const theme = { ...DARK, mode: 'dark' };

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export const DEFAULT_ACCENT = '#5fd787';
// The default accent on a light background: the same green, darker.
export const LIGHT_ACCENT = '#00875f';

export const THEMES = ['dark', 'light', 'auto'];

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** Sets the accent; anything that isn't a colour (no setting, say) puts this theme's default back. */
export function setAccent(color) {
  theme.accent = isColour(color) ? color : theme.mode === 'light' ? LIGHT_ACCENT : DEFAULT_ACCENT;
}

/**
 * The terminal's background from COLORFGBG ("15;0", "0;default;15"), which some terminals set: the
 * last number is the background's colour; 7 and 15 (white, bright white) are light. null when it
 * says nothing.
 */
export function backgroundFrom(colorfgbg) {
  const bg = String(colorfgbg ?? '').split(';').at(-1).trim();
  if (!/^\d+$/.test(bg)) return null;
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

/** The palette a setting asks for: dark, light, or with auto (or none) what COLORFGBG says, else dark. */
export function themeMode(setting, env = process.env) {
  if (setting === 'dark' || setting === 'light') return setting;
  return backgroundFrom(env.COLORFGBG) ?? 'dark';
}

/** Puts the config's theme (dark, light, auto) and accent in place. */
export function applyTheme(config = {}, env = process.env) {
  const mode = themeMode(config.theme, env);
  Object.assign(theme, mode === 'light' ? LIGHT : DARK, { mode });
  setAccent(config.accent);
  return mode;
}

/** Colour for a one-letter change code (M, A, D, R, ?, !). */
export function codeColor(code) {
  if (code === 'A' || code === '?') return theme.add;
  if (code === 'D' || code === '!') return theme.del;
  if (code === 'R' || code === 'C') return theme.local;
  return theme.warn;
}
