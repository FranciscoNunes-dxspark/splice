// Telling the terminal that something has finished, for when you've looked away: a bell, and a
// desktop notification through the escape sequence the terminal understands (OSC 9, as iTerm2,
// Windows Terminal, WezTerm and kitty take it, or OSC 777 for VTE terminals such as GNOME Terminal).
// Pure: cli.jsx writes what it returns. The same as Trawl's, plus what a pull request poll is worth saying.

// Seconds a command takes before its end is worth a notification, unless the config says otherwise.
export const NOTIFY_AFTER = 10;

// Nothing in the text may end the sequence early or start another.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x9b]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** The bytes that ring the bell and raise a notification saying `title` and `body`, for this terminal. */
export function notification(title, body, env = process.env) {
  const t = clean(title);
  const b = clean(body);
  const vte = Boolean(env.VTE_VERSION) || /^(foot|rxvt)/.test(env.TERM ?? '');
  const osc = vte ? `\x1b]777;notify;${t.replace(/;/g, ',')};${b.replace(/;/g, ',')}\x1b\\` : `\x1b]9;${b ? `${t}: ${b}` : t}\x07`;
  return `\x07${osc}`;
}

/** The seconds from the config's `notifyAfter`, or NOTIFY_AFTER. */
export const notifySeconds = (config) => (Number(config?.notifyAfter) >= 0 ? Number(config.notifyAfter) : NOTIFY_AFTER);

/** Whether a run of `ms` should notify, by the config's `notify` (on unless false) and `notifyAfter` (seconds). */
export const worthNotifying = (ms, config) => config?.notify !== false && ms >= notifySeconds(config) * 1000;

const REVIEWED = {
  APPROVED: 'approved it',
  CHANGES_REQUESTED: 'asked for changes',
  COMMENTED: 'commented on it',
  approved: 'approved it',
  suggestions: 'approved it with suggestions',
  rejected: 'rejected it',
  waiting: 'is waiting for changes',
};
const reviewKey = (r) => `${r.by}\n${r.state}\n${r.at ?? ''}`;

/**
 * What changed on your own pull requests between two polls of the PR list (hosting.js's shape), as
 * [{ title, body }]: checks that were running and have all finished (passed or failed), and reviews
 * that weren't there before. A PR seen for the first time says nothing: there's nothing to compare.
 */
export function prNews(before, after) {
  const out = [];
  const was = new Map((before ?? []).map((p) => [p.id, p]));
  for (const p of after ?? []) {
    const q = was.get(p.id);
    if (!p.mine || !q) continue;
    const title = `${p.label} ${p.title}`;
    const c = p.checks;
    if (q.checks?.pending && c && !c.pending && c.passed + c.failed > 0) {
      out.push({ title, body: c.failed ? `${c.failed} of ${c.passed + c.failed} checks failed` : `All ${c.passed} checks passed` });
    }
    const seen = new Set((q.reviews ?? []).map(reviewKey));
    for (const r of p.reviews ?? []) {
      if (seen.has(reviewKey(r)) || !r.by || r.by === p.author || !REVIEWED[r.state]) continue;
      out.push({ title, body: `${r.by} ${REVIEWED[r.state]}` });
    }
  }
  return out;
}
