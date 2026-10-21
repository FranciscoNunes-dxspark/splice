// The open pull requests, fetched once for the PRs and Branches views.
import { useAsync } from './hooks.js';

// PR list requests by key, finished or not, so PRs and Branches share one fetch (and one failure).
const prLists = new Map();

/**
 * The open pull requests of the repository's host (null without one), shared by the PRs and Branches
 * views. A new key every minute refetches while you look, and `prVersion` (r, or after approving or
 * opening one) does so at once; the old list stays up until the new one lands.
 */
export function usePrList(ctx, data, prVersion) {
  const host = ctx.host();
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
  return { host, key, ...state };
}
