import { readFileSync } from 'node:fs';

// The compiled builds have it baked in by scripts/build.js; from a checkout, read package.json.
export const VERSION =
  process.env.SPLICE_VERSION ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Releases are versioned when they're built, so a checkout's package.json lags behind them.
export const COMPILED = process.env.SPLICE_VERSION !== undefined;
