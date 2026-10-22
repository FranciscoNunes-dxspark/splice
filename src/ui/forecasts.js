// The Branches view's conflict marks: whether each branch would conflict with the default branch,
// worked out in the background by forecast.js, one git at a time so the view never waits on them.
import { useEffect, useRef, useState } from 'react';
import { ForecastUnsupported, forecast, knownForecast } from '../forecast.js';

/**
 * Forecasts for `list` ([{ oid }]: the selected branch first, then the ones on screen) against `base`
 * ({ oid }), in that order. When the list changes (the cursor or the scroll moved), the git under way
 * finishes and the new list is worked through from its top. `get(oid)` is the answer for one branch,
 * undefined until it's known; `why` says why there are none (a git before 2.38).
 */
export function useForecasts(root, base, list) {
  const [, setVersion] = useState(0);
  const [why, setWhy] = useState(null);
  const want = useRef({ root, base, list });
  want.current = { root, base, list };
  const worker = useRef(null);
  const failed = useRef(new Set());
  const listKey = list.map((b) => b.oid).join(' ');

  useEffect(() => () => worker.current?.abort(), []);
  useEffect(() => {
    if (!root || !base?.oid || !list.length || why) return;
    // A moment's wait, so scrolling through the list doesn't start a git for every row it passes.
    const t = setTimeout(async () => {
      // The one running reads the latest list before each git, so it picks this one up.
      if (worker.current) return;
      const controller = new AbortController();
      worker.current = controller;
      try {
        for (;;) {
          const cur = want.current;
          const pending = (b) => knownForecast(cur.base?.oid, b.oid) === undefined && !failed.current.has(`${cur.base?.oid}:${b.oid}`);
          const next = cur.base?.oid ? cur.list.find(pending) : null;
          if (!next || controller.signal.aborted) break;
          try {
            // By hash, which can't be mistaken for anything else.
            await forecast(cur.root, cur.base.oid, next.oid, { signal: controller.signal, oids: [cur.base.oid, next.oid] });
          } catch (e) {
            if (e instanceof ForecastUnsupported) {
              setWhy(e.message);
              break;
            }
            if (e.cancelled) break;
            // Unrelated histories, a commit not fetched: no mark, and no asking again.
            failed.current.add(`${cur.base.oid}:${next.oid}`);
          }
          setVersion((v) => v + 1);
        }
      } finally {
        worker.current = null;
      }
    }, 150);
    return () => clearTimeout(t);
  }, [root, base?.oid, listKey, why]);

  return { get: (oid) => knownForecast(base?.oid, oid), why };
}
