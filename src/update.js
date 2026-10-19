// Whether a newer Tiller has been released. Asked at most once a day, in the background, and
// silent when it can't tell (offline, no gh). "checkForUpdates": false in the config turns it off.
import { cli } from './hosting.js';
import { VERSION } from './version.js';

export const REPO = 'FranciscoNunes-dxspark/tiller';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const DAY = 24 * 60 * 60 * 1000;

/** Compares two "1.2.3" versions (a leading v is fine); a pre-release sorts before its release. Unreadable ones count as equal. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (Boolean(x[4]) !== Boolean(y[4])) return x[4] ? -1 : 1;
  return 0;
}

/** The latest release, as { version, url }. Throws if it can't be found out. */
export async function fetchLatestRelease() {
  // Without a sign-in first: that works for anyone once the repository is public, with nothing installed.
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `tiller/${VERSION}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return release(await res.json());
  } catch {
    // Offline or blocked; gh may still get through.
  }
  // A private repository answers 404 to that, so ask through gh, with the sign-in it already has.
  return release(JSON.parse(await cli('gh', ['api', `repos/${REPO}/releases/latest`], { signal: AbortSignal.timeout(15000) })));
}

function release(body) {
  const version = String(body?.tag_name ?? '').replace(/^v/, '');
  if (!version) throw new Error('No release found');
  return { version, url: body.html_url || RELEASES_URL };
}

/**
 * What the last check found (`last`: { at, latest, url } from the config), asking again when it's
 * a day old. Resolves with { checked, newer }; `checked` goes back into the config.
 */
export async function checkForUpdate(last, { current = VERSION, now = Date.now(), fetchLatest = fetchLatestRelease } = {}) {
  let checked = last;
  // A check from the future (the clock moved back) counts as stale too.
  if (!last?.latest || !(now - last.at >= 0 && now - last.at < DAY)) {
    const latest = await fetchLatest();
    checked = { at: now, latest: latest.version, url: latest.url };
  }
  return { checked, newer: compareVersions(checked.latest, current) > 0 };
}
