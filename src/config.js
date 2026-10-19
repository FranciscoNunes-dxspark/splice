import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Read per call so tests can point TILLER_HOME somewhere temporary.
const configDir = () => process.env.TILLER_HOME || join(homedir(), '.tiller');

const DEFAULTS = { recent: [], roots: [], history: [] };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'config.json'), JSON.stringify(config, null, 2));
  } catch {
    // A read-only home folder shouldn't stop the app; settings just won't stick.
  }
}

/** Compares paths the way the file system does: case-insensitively on Windows. */
export function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/** Moves `root` to the front of the recent list. */
export function withRecent(config, root) {
  return { ...config, recent: [root, ...config.recent.filter((r) => !samePath(r, root))].slice(0, 30) };
}
