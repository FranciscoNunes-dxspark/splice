// The open pull requests, fetched once for the PRs and Branches views.
import { useEffect, useState } from 'react';
import { prNews } from '../notify.js';
import { useAsync } from './hooks.js';

// PR list requests by key, finished or not, so PRs and Branches share one fetch (and one failure).
const prLists = new Map();

/**
 * The open pull requests of the repository's host (null without one), shared by the PRs and Branches
 * views. A new key every minute refetches while you look (a timer redraws on the minute, so it does
 * even when nothing else changes), and `prVersion` (r, or after approving or opening one) does so at
 * once; the old list stays up until the new one lands. Each new list is compared with the one before
 * (notify.js's prNews), and what changed on your own pull requests goes to `ctx.prNews`.
 */
export function usePrList(ctx, data, prVersion) {
  const host = ctx.host();
  const [, setMinute] = useState(0);
  useEffect(() => {
    if (!host) return;
    let t;
    const next = () => {
      t = setTimeout(() => {
        setMinute((n) => n + 1);
        next();
      }, 60000 - (Date.now() % 60000) + 50);
    };
    next();
    return () => clearTimeout(t);
  }, [host]);
  const key = host ? `prs:${data.root}:${host.remoteName}:${prVersion}:${Math.floor(Date.now() / 60000)}` : null;
  const state = useAsync(
    key,
    () => {
      if (!prLists.has(key)) {
        prLists.set(key, host.list());
        if (prLists.size > 20) prLists.delete(prLists.keys().next().value);
      }
      return prLists.get(key);
    },
    0,
  );
  // The last list seen for each repository and remote, kept on ctx so it lasts while the view is away.
  useEffect(() => {
    if (!host || !state.value) return;
    ctx.prSeen ??= new Map();
    const at = `${data.root}\n${host.remoteName}`;
    const before = ctx.prSeen.get(at);
    ctx.prSeen.set(at, state.value);
    if (before && before !== state.value) {
      const news = prNews(before, state.value);
      if (news.length) ctx.prNews?.(news);
    }
  }, [state.value]);
  return { host, key, ...state };
}
