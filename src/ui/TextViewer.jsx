import React, { useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { withThreads } from '../review.js';
import { lineText, markRanges, matcher, matchingLines, wordChanges } from '../search.js';
import { theme } from '../theme.js';
import { clean } from '../text.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { RANGE_COMMIT, diffSegments, rangeDiffSegments } from './diffstyle.js';

/**
 * Full-height scrollable text: diffs, command output, help, Claude's answers (`markdown`: formatted and
 * wrapped to fit). / searches it: matches are picked out, n/N go from one to the next. A pull request's
 * diff (`pr`) comes with its review `threads`, drawn under the lines they're about: t/T go from one to
 * the next, r replies to the one picked (or the first on screen) through /reply. `rangeDiff`: git
 * range-diff's output, coloured as such, n/N going from commit to commit.
 */
export function TextViewer({ title, text, loading, diff, rangeDiff, markdown, threads, pr, ctx, width, height, active, onClose }) {
  const [threadId, setThreadId] = useState(null);
  const { lines, starts } = useMemo(() => {
    const t = (text ?? '').replace(/\n$/, '');
    if (markdown) return { lines: renderMarkdown(t, width - 2), starts: [] };
    if (threads?.length) return withThreads(t.split('\n'), threads, width - 2, { current: threadId });
    return { lines: t.split('\n'), starts: [] };
  }, [text, markdown, width, threads, threadId]);
  // Diff lines are drawn cleaned (tabs to spaces), so the changed words are found in that text.
  const words = useMemo(() => (diff ? wordChanges(lines.map((l) => (typeof l === 'string' ? clean(l) : ''))) : null), [lines, diff]);
  const [offset, setOffset] = useState(0);
  const innerH = height - 2;
  const max = Math.max(0, lines.length - innerH);
  const to = (n) => setOffset(Math.max(0, Math.min(max, n)));

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
    if (k >= 0) to(list[k] - Math.min(3, Math.floor(innerH / 3)));
  };
  const typed = (query) => {
    const list = matchingLines(lines, query);
    setSearch((s) => ({ ...s, query }));
    // As you type, the first match from where the search started.
    const k = list.findIndex((l) => l >= searchRef.current.from);
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
              ? Math.max(0, starts.findIndex((s) => s.at >= offset))
              : Math.max(0, starts.findLastIndex((s) => s.at < offset));
        setThreadId(starts[next].thread.id);
        return to(starts[next].at - 2);
      }
      if (input === 'r' && pr) {
        const picked = starts.find((s) => s.thread.id === threadId) ?? starts.find((s) => s.at >= offset && s.at < offset + innerH);
        if (!picked) return ctx.note(starts.length ? 'No comment on screen to reply to: t goes to the next one.' : 'This pull request has no review comments to reply to.', 'error');
        ctx.reviewThread = { pr, thread: picked.thread };
        setThreadId(picked.thread.id);
        return ctx.prefill('/reply ');
      }
      if (key.downArrow || input === 'j') to(offset + 1);
      else if (key.upArrow || input === 'k') to(offset - 1);
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) to(offset + innerH - 1);
      else if (key.pageUp || (key.ctrl && input === 'u')) to(offset - innerH + 1);
      else if (input === 'g') to(0);
      else if (input === 'G') to(max);
      else if ((input === 'n' || input === 'N') && searchRef.current.query) {
        const list = matchingLines(lines, searchRef.current.query);
        const n = list.length;
        if (!n) return;
        // From the match last shown, or else from what's on screen; past the last one, round to the first.
        if (hereRef.current >= 0) return show(input === 'n' ? (hereRef.current + 1) % n : (hereRef.current - 1 + n) % n, list);
        const after = list.findIndex((l) => l >= offset);
        show(input === 'n' ? Math.max(after, 0) : ((after >= 0 ? after : n) - 1 + n) % n, list);
      } else if (input === 'n' || input === 'N') {
        // Jump to the next (or previous) hunk or file.
        const isMark = (l) => typeof l === 'string' && (rangeDiff ? RANGE_COMMIT.test(l) : l.startsWith('@@') || l.startsWith('diff --git'));
        if (input === 'n') {
          const i = lines.findIndex((l, j) => j > offset && isMark(l));
          if (i >= 0) to(i);
        } else {
          for (let j = offset - 1; j >= 0; j--) if (isMark(lines[j])) return to(j);
        }
      }
    },
    { isActive: active },
  );
  useMouse(ctx, (e) => e.wheel && setOffset((o) => Math.max(0, Math.min(max, o + e.wheel * 3))));

  const find = matcher(search.query);
  const segmentsOf = (l, idx) => {
    const segs = typeof l !== 'string' ? l : rangeDiff ? rangeDiffSegments(l) : diff ? diffSegments(l, words.get(idx)) : [{ text: l }];
    if (!find) return segs;
    const hereLine = here >= 0 && matches[here] === idx;
    return markRanges(segs, find(lineText(segs)), { bg: hereLine ? theme.matchHere : theme.match, color: theme.ink });
  };

  const pos = lines.length > innerH ? `${Math.min(lines.length, offset + innerH)}/${lines.length}` : '';
  const found = matches.length ? `${here >= 0 ? `${here + 1}/` : ''}${matches.length} line${matches.length === 1 ? '' : 's'}` : 'no match';
  const hint = search.typing
    ? `/${search.query}▏ ${search.query ? found : ''} · ↵ done · esc cancel`
    : search.query
      ? `"${search.query}" ${found} · n/N · esc clears`
      : `${pos}${pos ? ' · ' : ''}${starts.length ? `${starts.length} comment${starts.length === 1 ? '' : 's'} · t/T · r reply · ` : ''}/ search · esc close`;
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
      {loading ? (
        <Row pointer={false} width={width - 2} segments={[{ text: 'Loading…', color: theme.dim }]} />
      ) : (
        lines.slice(offset, offset + innerH).map((l, i) => <Row key={offset + i} pointer={false} width={width - 2} segments={segmentsOf(l, offset + i)} />)
      )}
    </Panel>
  );
}
