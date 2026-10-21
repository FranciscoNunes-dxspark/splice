import React, { useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { renderMarkdown } from '../markdown.js';
import { lineTarget, withThreads } from '../review.js';
import { lineText, markRanges, matcher, matchingLines, wordChanges } from '../search.js';
import { SPLIT_WIDTH, lineOn, rowLines, sideOf, splitView } from '../split.js';
import { theme } from '../theme.js';
import { clean, fitSegments } from '../text.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { diffSegments } from './diffstyle.js';

/**
 * Full-height scrollable text: diffs, command output, help, Claude's answers (`markdown`: formatted and
 * wrapped to fit). / searches it: matches are picked out, n/N go from one to the next. A pull request's
 * diff (`pr`) comes with its review `threads`, drawn under the lines they're about: t/T go from one to
 * the next, r replies to the one picked (or the first on screen) through /reply, x resolves it or opens
 * it again. That diff has a line cursor, which j/k move rather than scroll: c comments on its line
 * through /review-comment, and moving into a thread's box picks that thread. w shows a diff side by
 * side (split.js) where the window is wide enough, and back in one column; the choice is the
 * sideBySide setting. Everything else goes by line, whichever way it's drawn: scrolling counts the
 * rows on screen, and the cursor is on one side of a pair (h/l pick which).
 */
export function TextViewer({ title, text, loading, diff, markdown, threads, pr, ctx, width, height, active, onClose }) {
  const [threadId, setThreadId] = useState(null);
  const lineCursor = Boolean(pr) && !markdown;
  const { lines, starts, rows } = useMemo(() => {
    const t = (text ?? '').replace(/\n$/, '');
    if (markdown) return { lines: renderMarkdown(t, width - 2), starts: [], rows: null };
    if (pr || threads?.length) return withThreads(t.split('\n'), threads ?? [], width - 2, { current: threadId });
    return { lines: t.split('\n'), starts: [], rows: null };
  }, [text, markdown, width, threads, threadId, pr]);
  // Diff lines are drawn cleaned (tabs to spaces), so the changed words are found in that text. Only the
  // diff's own lines are compared, so a thread under a removed line doesn't keep it from its added one.
  const words = useMemo(() => {
    if (!diff) return null;
    const own = rows ? rows.flatMap((r, i) => (r.diff != null ? [i] : [])) : lines.map((_, i) => i);
    const found = wordChanges(own.map((i) => (typeof lines[i] === 'string' ? clean(lines[i]) : '')));
    return new Map([...found].map(([k, r]) => [own[k], r]));
  }, [lines, rows, diff]);
  // What's on screen: rows of lines, one line each, or the two sides of a diff (`view`), and the row
  // each line is in (`rowOf`). The offset counts rows.
  const canSplit = Boolean(diff) && !markdown;
  const split = canSplit && ctx.config?.sideBySide === true && width >= SPLIT_WIDTH;
  const { view, rowOf, digits } = useMemo(
    () => (split ? splitView(lines, rows) : { view: lines.map((_, i) => ({ full: i })), rowOf: lines.map((_, i) => i), digits: 0 }),
    [lines, rows, split],
  );
  const [offset, setOffset] = useState(0);
  const innerH = height - 2;
  const max = Math.max(0, view.length - innerH);
  const to = (n) => setOffset(Math.max(0, Math.min(max, n)));

  // The line cursor, kept as its row's key (and index, should that row go): threads arriving or growing
  // above it leave it on the same line. In a ref as well, for keys typed faster than renders.
  const rowIndex = useMemo(() => new Map((rows ?? []).map((r, i) => [r.key, i])), [rows]);
  const [cursorAt, setCursorAt] = useState({ key: null, index: 0 });
  const cursorRef = useRef(cursorAt);
  const cur = () => rowIndex.get(cursorRef.current.key) ?? Math.max(0, Math.min(lines.length - 1, cursorRef.current.index));
  const cursor = lineCursor ? cur() : -1;
  // The side the cursor keeps to as it moves, side by side: 'old' (left) or 'new' (right).
  const [side, setSideState] = useState('new');
  const sideRef = useRef(side);
  const setSide = (s) => {
    sideRef.current = s;
    setSideState(s);
  };

  // Switching between one column and two (w, or the window resized past the width) keeps the line
  // that was on top on top, and the cursor in view.
  const topLine = useRef(0);
  const [shownSplit, setShownSplit] = useState(split);
  if (shownSplit !== split) {
    setShownSplit(split);
    let next = rowOf[topLine.current] ?? 0;
    if (lineCursor) {
      const c = rowOf[cur()] ?? 0;
      if (c < next) next = c;
      if (c >= next + innerH) next = c - innerH + 1;
    }
    setOffset(Math.max(0, Math.min(max, next)));
  } else topLine.current = view[offset] ? rowLines(view[offset])[0] : 0;
  const pickThread = (thread) => {
    setThreadId(thread.id);
    ctx.reviewThread = { pr, thread };
  };
  // Moves the cursor to line i, the view scrolled to `top` (or by `scroll`), and then as far as it takes to show it.
  const moveCursor = (i, { top = null, scroll = 0 } = {}) => {
    if (!rows?.length) return;
    const n = Math.max(0, Math.min(rows.length - 1, i));
    cursorRef.current = { key: rows[n].key, index: n };
    setCursorAt(cursorRef.current);
    if (rows[n].thread && rows[n].thread.id !== threadId) pickThread(rows[n].thread);
    const r = rowOf[n] ?? n;
    setOffset((o) => {
      let next = top ?? o + scroll;
      if (r < next) next = r;
      if (r >= next + innerH) next = r - innerH + 1;
      return Math.max(0, Math.min(max, next));
    });
  };
  // Without a cursor the keys scroll the text; with one they move it a row at a time (keeping to its
  // side, side by side), and the view follows.
  const step = (n) => {
    if (!lineCursor) return to(offset + n);
    const r = Math.max(0, Math.min(view.length - 1, (rowOf[cur()] ?? 0) + n));
    moveCursor(lineOn(view[r], sideRef.current), { scroll: Math.abs(n) > 1 ? n : 0 });
  };
  // Line i, with the row `top` on top (by default its own).
  const jump = (i, top = rowOf[i] ?? 0) => (lineCursor ? moveCursor(i, { top }) : to(top));
  const onScreen = (i) => rowOf[i] >= offset && rowOf[i] < offset + innerH;
  // The thread r and x act on: the one the cursor is in, else the one picked, else the first on screen.
  const pickedThread = () =>
    (lineCursor && rows[cur()]?.thread) ||
    (starts.find((s) => s.thread.id === threadId) ?? starts.find((s) => onScreen(s.at)))?.thread;
  const noThread = () => ctx.note(starts.length ? 'No comment on screen: t goes to the next one.' : 'This pull request has no review comments yet.', 'error');

  // `typing` while the query is being typed after /; `from` is where the view was when it started.
  // Kept in refs as well as state: keys typed faster than renders each see the one before.
  const [search, setSearchState] = useState({ query: '', typing: false, from: 0 });
  const searchRef = useRef(search);
  const setSearch = (next) => {
    searchRef.current = typeof next === 'function' ? next(searchRef.current) : next;
    setSearchState(searchRef.current);
  };
  const matches = useMemo(() => matchingLines(lines, search.query), [lines, search.query]);
  // Which match was shown last (an index into `matches`), -1 for none.
  const [here, setHereState] = useState(-1);
  const hereRef = useRef(here);
  const setHere = (k) => {
    hereRef.current = k;
    setHereState(k);
  };
  // A match in view a few lines down, not on the top line, so what leads up to it shows too.
  const show = (k, list = matches) => {
    setHere(k);
    if (k >= 0) jump(list[k], rowOf[list[k]] - Math.min(3, Math.floor(innerH / 3)));
  };
  const typed = (query) => {
    const list = matchingLines(lines, query);
    setSearch((s) => ({ ...s, query }));
    // As you type, the first match from where the search started.
    const k = list.findIndex((l) => rowOf[l] >= searchRef.current.from);
    if (list.length) show(k >= 0 ? k : 0, list);
    else {
      setHere(-1);
      to(searchRef.current.from);
    }
  };

  const searchKeys = (input, key) => {
    if (key.escape) {
      const { from } = searchRef.current;
      setSearch({ query: '', typing: false, from: 0 });
      setHere(-1);
      return to(from);
    }
    if (key.return) return setSearch((s) => ({ ...s, typing: false }));
    if (key.backspace || key.delete) return typed(searchRef.current.query.slice(0, -1));
    if (key.ctrl && input === 'u') return typed('');
    if (key.ctrl || key.meta || !input) return;
    const add = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (add) typed(searchRef.current.query + add);
  };

  useInput(
    (input, key) => {
      if (searchRef.current.typing) return searchKeys(input, key);
      if (key.escape && searchRef.current.query) {
        setSearch({ query: '', typing: false, from: 0 });
        return setHere(-1);
      }
      if (key.escape || input === 'q') return onClose();
      if (input === '/') return setSearch({ query: '', typing: true, from: offset });
      if ((input === 't' || input === 'T') && starts.length) {
        const k = starts.findIndex((s) => s.thread.id === threadId);
        const next =
          k >= 0
            ? (k + (input === 't' ? 1 : starts.length - 1)) % starts.length
            : input === 't'
              ? Math.max(0, starts.findIndex((s) => rowOf[s.at] >= offset))
              : Math.max(0, starts.findLastIndex((s) => rowOf[s.at] < offset));
        pickThread(starts[next].thread);
        return jump(starts[next].at, rowOf[starts[next].at] - 2);
      }
      if (input === 'w' && canSplit) return a.toggleSideBySide(ctx, { width, need: SPLIT_WIDTH });
      // Side by side, the cursor goes to the line on the other side of its row.
      if (split && lineCursor && (key.leftArrow || key.rightArrow || input === 'h' || input === 'l')) {
        setSide(key.leftArrow || input === 'h' ? 'old' : 'new');
        return moveCursor(lineOn(view[rowOf[cur()] ?? 0], sideRef.current));
      }
      if (input === 'r' && pr) {
        const thread = pickedThread();
        if (!thread) return noThread();
        pickThread(thread);
        return ctx.prefill('/reply ');
      }
      if (input === 'x' && pr) {
        const thread = pickedThread();
        if (!thread) return noThread();
        pickThread(thread);
        return a.resolveThread(ctx, !thread.resolved, { pr, thread });
      }
      if (input === 'c' && lineCursor) {
        const row = rows[cur()];
        if (row?.thread) return ctx.note("That's a review comment: r replies to it. c comments on a line of the diff.", 'error');
        // An unchanged line is commented on as it is on the side the cursor's on.
        const at = lineTarget(row?.at, lines[cur()], split ? sideRef.current : 'new');
        if (!at) return ctx.note('Only changed lines and those shown around them can be commented on.', 'error');
        ctx.reviewLine = { pr, at };
        return ctx.prefill('/review-comment ');
      }
      if (key.downArrow || input === 'j') step(1);
      else if (key.upArrow || input === 'k') step(-1);
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) step(innerH - 1);
      else if (key.pageUp || (key.ctrl && input === 'u')) step(-innerH + 1);
      else if (input === 'g') jump(0);
      else if (input === 'G') jump(lines.length - 1);
      else if ((input === 'n' || input === 'N') && searchRef.current.query) {
        const list = matchingLines(lines, searchRef.current.query);
        const n = list.length;
        if (!n) return;
        // From the match last shown, or else from what's on screen; past the last one, round to the first.
        if (hereRef.current >= 0) return show(input === 'n' ? (hereRef.current + 1) % n : (hereRef.current - 1 + n) % n, list);
        const after = list.findIndex((l) => rowOf[l] >= offset);
        show(input === 'n' ? Math.max(after, 0) : ((after >= 0 ? after : n) - 1 + n) % n, list);
      } else if (input === 'n' || input === 'N') {
        // Jump to the next (or previous) hunk or file.
        const isMark = (l) => typeof l === 'string' && (l.startsWith('@@') || l.startsWith('diff --git'));
        const from = lineCursor ? cur() : view[offset] ? rowLines(view[offset])[0] : 0;
        if (input === 'n') {
          const i = lines.findIndex((l, j) => j > from && isMark(l));
          if (i >= 0) jump(i);
        } else {
          for (let j = from - 1; j >= 0; j--) if (isMark(lines[j])) return jump(j);
        }
      }
    },
    { isActive: active },
  );
  useMouse(ctx, (e) => {
    if (e.wheel) return setOffset((o) => Math.max(0, Math.min(max, o + e.wheel * 3)));
    // Lines start under the panel's top border; a click puts the cursor on one (on the side clicked).
    const row = view[offset + e.y - 1];
    if (!lineCursor || e.y < 1 || e.y > innerH || !row) return;
    if (row.full == null) setSide(e.x - 1 < leftW ? 'old' : 'new');
    moveCursor(lineOn(row, sideRef.current));
  });

  const find = matcher(search.query);
  const segmentsOf = (l, idx) => {
    const segs = typeof l !== 'string' ? l : diff ? diffSegments(l, words.get(idx)) : [{ text: l }];
    if (!find) return segs;
    const hereLine = here >= 0 && matches[here] === idx;
    return markRanges(segs, find(lineText(segs)), { bg: hereLine ? theme.matchHere : theme.match, color: theme.ink });
  };

  // Side by side: each half a line number and the line, the cursor's half lit up.
  const inner = width - 2;
  const leftW = Math.floor((inner - 1) / 2);
  const half = (row, i, no, w, s) => {
    if (i == null) return [{ text: ' '.repeat(w) }];
    const segs = fitSegments([{ text: `${no == null ? '' : no}`.padStart(digits) + ' ', color: theme.dim }, ...segmentsOf(lines[i], i)], w);
    const here = i === cursor && active && (sideOf(row, i) !== 'both' || side === s);
    return here ? segs.map((g) => ({ ...g, bg: g.bg ?? theme.selBg })) : segs;
  };
  const drawRow = (row, v) =>
    row.full != null ? (
      <Row key={v} pointer={false} selected={row.full === cursor} focused={active} width={inner} segments={segmentsOf(lines[row.full], row.full)} />
    ) : (
      <Row key={v} pointer={false} width={inner} segments={[...half(row, row.left, row.old, leftW, 'old'), { text: '│', color: theme.border }, ...half(row, row.right, row.new, inner - 1 - leftW, 'new')]} />
    );

  const pos = view.length > innerH ? `${Math.min(view.length, offset + innerH)}/${view.length}` : '';
  const found = matches.length ? `${here >= 0 ? `${here + 1}/` : ''}${matches.length} line${matches.length === 1 ? '' : 's'}` : 'no match';
  const splitHint = canSplit && width >= SPLIT_WIDTH ? (split ? `w one column · ${lineCursor ? 'h/l side · ' : ''}` : 'w side by side · ') : '';
  const hint = search.typing
    ? `/${search.query}▏ ${search.query ? found : ''} · ↵ done · esc cancel`
    : search.query
      ? `"${search.query}" ${found} · n/N · esc clears`
      : `${pos}${pos ? ' · ' : ''}${starts.length ? `${starts.length} comment${starts.length === 1 ? '' : 's'} · t/T · r reply · x resolve · ` : ''}${pr ? 'c comment · ' : ''}${splitHint}/ search · esc close`;
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
      {loading ? (
        <Row pointer={false} width={width - 2} segments={[{ text: 'Loading…', color: theme.dim }]} />
      ) : (
        view.slice(offset, offset + innerH).map((row, i) => drawRow(row, offset + i))
      )}
    </Panel>
  );
}
