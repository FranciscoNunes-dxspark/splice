import { useEffect, useRef, useState } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  return size;
}

/**
 * Cursor and scroll position for a list of `count` rows shown `height` at a time.
 * Rows where `selectable(i)` is false (section headers) are skipped over.
 * `resetKey` puts the cursor back on top when it changes (another repo, another filter).
 */
export function useListNav(count, height, { selectable = () => true, resetKey } = {}) {
  const [index, setIndex] = useState(0);
  const offset = useRef(0);
  const lastKey = useRef(resetKey);
  // Scrolled with the wheel, the view leaves the cursor where it was, out of sight if need be,
  // until the cursor moves again.
  const free = useRef(false);
  const [, setScrolled] = useState(0);
  let i = index;
  if (lastKey.current !== resetKey) {
    lastKey.current = resetKey;
    i = 0;
    offset.current = 0;
    free.current = false;
    if (index !== 0) setIndex(0);
  }

  const find = (from, dir) => {
    for (let j = from; j >= 0 && j < count; j += dir) if (selectable(j)) return j;
    return -1;
  };
  i = Math.max(0, Math.min(i, count - 1));
  if (count && !selectable(i)) {
    const down = find(i, 1);
    i = down >= 0 ? down : Math.max(0, find(i, -1));
  }

  const h = Math.max(1, height);
  if (!free.current) {
    if (i < offset.current) offset.current = i;
    if (i >= offset.current + h) offset.current = i - h + 1;
    // Keep a section header in view above the first row under it.
    if (i > 0 && i === offset.current && !selectable(i - 1)) offset.current = i - 1;
  }
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, count - h)));

  const moveTo = (j) => {
    free.current = false;
    setIndex(j);
  };
  const go = (target, dir) => {
    const t = Math.max(0, Math.min(target, count - 1));
    let j = find(t, dir);
    if (j < 0) j = find(t, -dir);
    if (j >= 0) moveTo(j);
  };

  const handle = (input, key) => {
    if (!count) return false;
    if (key.downArrow || input === 'j') go(i + 1, 1);
    else if (key.upArrow || input === 'k') go(i - 1, -1);
    else if (key.pageDown || (key.ctrl && input === 'd')) go(i + h - 1, 1);
    else if (key.pageUp || (key.ctrl && input === 'u')) go(i - h + 1, -1);
    else if (input === 'g' || key.home) go(0, 1);
    else if (input === 'G' || key.end) go(count - 1, -1);
    else return false;
    return true;
  };

  /** Puts the cursor on the visible row `row` (a click), if that row takes it. Returns whether it did. */
  const pick = (row) => {
    const j = offset.current + row;
    if (row < 0 || row >= h || j >= count || !selectable(j)) return false;
    moveTo(j);
    return true;
  };

  /** Scrolls the list `n` rows (the wheel), leaving the cursor where it is. */
  const scrollBy = (n) => {
    if (!count) return;
    free.current = true;
    offset.current = Math.max(0, Math.min(offset.current + n, count - h));
    setScrolled((s) => s + 1);
  };

  return { index: i, offset: offset.current, handle, setIndex: moveTo, pick, scrollBy };
}

/**
 * Mouse events for the component in the main area: wheel notches and left presses, with `y` counted
 * from the top of the main area and `double` set on a double-click. App hands them to the handler of
 * the component mounted last, which is the one on screen (a view, or an overlay over it).
 */
export function useMouse(ctx, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (e) => ref.current(e);
    ctx.mouseHandlers.push(fn);
    return () => {
      ctx.mouseHandlers = ctx.mouseHandlers.filter((h) => h !== fn);
    };
  }, []);
}

// Results of slow reads (diffs, commit details), keyed by what was asked, so moving back is instant.
const cache = new Map();

/**
 * Runs `load` for `key` after a short pause (so holding j doesn't spawn a git per row),
 * keeping the previous value on screen until the new one arrives.
 */
export function useAsync(key, load, delay = 60) {
  const [state, setState] = useState(() => (cache.has(key) ? { value: cache.get(key), key } : { loading: true }));
  useEffect(() => {
    if (key == null) return;
    if (cache.has(key)) {
      setState({ value: cache.get(key), key });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      load().then(
        (value) => {
          cache.set(key, value);
          if (cache.size > 300) cache.delete(cache.keys().next().value);
          if (live) setState({ value, key });
        },
        (error) => live && setState({ error, key }),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return state;
}

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
