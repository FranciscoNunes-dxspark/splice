import React, { useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { dirname, basename } from 'node:path/posix';
import * as a from '../actions.js';
import { promptMessage } from '../message.js';
import { hunkPicks, isChange, parseDiff } from '../patch.js';
import { changeDiff } from '../repo.js';
import { ownersLine, ownersOf } from '../codeowners.js';
import { wordChanges } from '../search.js';
import { SPLIT_WIDTH, rowLines, splitView } from '../split.js';
import { codeColor, theme } from '../theme.js';
import { clean, fitSegments } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { diffSegments } from './diffstyle.js';
import { ConflictPane, useConflicts } from './ConflictPane.jsx';

// `lfs`: the files Git LFS keeps (data.lfs.files), marked with whether the working tree has the content or only its pointer.
function fileSegments(f, lfs) {
  const dir = dirname(f.path);
  const segs = [
    { text: `${f.code} `, color: codeColor(f.code), bold: true },
    { text: dir === '.' ? '' : `${dir}/`, color: theme.dim },
    { text: basename(f.path), strong: true },
  ];
  if (f.orig && f.area === 'staged') segs.push({ text: `  ← ${f.orig}`, color: theme.dim });
  const kept = lfs?.[f.path];
  if (kept) segs.push(kept.content ? { text: '  LFS', color: theme.dim } : { text: '  LFS pointer', color: theme.warn });
  return segs;
}

const SUB_STATE = {
  uninitialised: ['○', 'not initialised', 'warn'],
  'out of date': ['↻', 'out of date', 'warn'],
  conflict: ['!', 'conflict', 'del'],
  modified: ['●', 'changes inside', 'warn'],
  ok: ['✓', 'up to date', 'dim'],
};

function subSegments(s) {
  const [icon, text, tone] = SUB_STATE[s.state] ?? SUB_STATE.ok;
  return [
    { text: `${icon} `, color: theme[tone], bold: true },
    { text: s.path, strong: true },
    { text: `  ${text}`, color: theme[tone] },
    { text: s.describe ? `  ${s.describe}` : '', color: theme.dim },
  ];
}

function subLines(s) {
  const [, text, tone] = SUB_STATE[s.state] ?? SUB_STATE.ok;
  const what = {
    uninitialised: 'Not cloned or checked out yet. I initialises it.',
    'out of date': 'It has another commit checked out than the one this repository records. I checks out the recorded one; committing here records the one it has.',
    conflict: 'Both sides of the merge moved it. Stage the commit it should have.',
    modified: 'It has uncommitted changes of its own: o opens it to commit or discard them.',
    ok: 'At the commit this repository records.',
  }[s.state];
  return [
    [{ text: s.path, bold: true }, { text: `  ${text}`, color: theme[tone] }],
    [{ text: s.sha.slice(0, 10), color: theme.warn }, { text: s.describe ? `  ${s.describe}` : '', color: theme.dim }],
    '',
    [{ text: what ?? '' }],
    '',
    [{ text: 'I init/update · o open it as a repository · /submodules lists them all', color: theme.dim }],
  ];
}

// The diff as rows: each hunk's header, then its lines. Only + and - lines take the cursor.
function diffRows(diff, raw) {
  if (!diff.hunks.length) return raw.split('\n').map((text) => ({ text }));
  const rows = [];
  diff.hunks.forEach((h, hunk) => {
    rows.push({ text: h.header, hunk });
    h.lines.forEach((text, line) => rows.push({ text, hunk, line, change: isChange(text) }));
  });
  return rows;
}

// A side-by-side row of the diff, `width` wide: each half its line number and line.
function pairSegments(row, dRows, words, digits, width) {
  const leftW = Math.floor((width - 1) / 2);
  const half = (j, no, w) =>
    j == null ? [{ text: ' '.repeat(w) }] : fitSegments([{ text: `${no ?? ''}`.padStart(digits) + ' ', color: theme.dim }, ...diffSegments(dRows[j].text, words.get(j))], w);
  return [...half(row.left, row.old, leftW), { text: '│', color: theme.border }, ...half(row.right, row.new, width - 1 - leftW)];
}

export function ChangesView({ data, ctx, width, height, active }) {
  const { conflicts, unstaged, staged } = data.changes;
  const rows = useMemo(() => {
    const out = [];
    const section = (title, list, empty) => {
      out.push({ header: title, count: list.length });
      if (!list.length && empty) out.push({ note: empty });
      for (const f of list) out.push({ file: f });
    };
    if (conflicts.length) section('Conflicts', conflicts);
    section('Unstaged', unstaged, 'Nothing to stage');
    section('Staged', staged, 'Nothing staged yet');
    if (data.submodules?.length) {
      out.push({ header: 'Submodules', count: data.submodules.length });
      for (const s of data.submodules) out.push({ sub: s });
    }
    return out;
  }, [data.changes, data.submodules]);

  const split = width >= 90;
  // Diffs side by side (w, the sideBySide setting) narrow the list, down to 36 columns, to make room.
  const LIST_MIN = 36;
  const sideBySide = ctx.config?.sideBySide === true && split && width - LIST_MIN >= SPLIT_WIDTH;
  const listW = !split ? width : sideBySide ? Math.max(LIST_MIN, Math.min(Math.floor(width * 0.4), width - SPLIT_WIDTH)) : Math.max(LIST_MIN, Math.floor(width * 0.4));
  const innerH = height - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.file || rows[i]?.sub), resetKey: data.root });
  const f = rows[nav.index]?.file;
  const sub = rows[nav.index]?.sub;
  // Who owns the selected file (CODEOWNERS), beside it in the list and in the diff's title.
  const owned = f && data.codeowners ? ownersLine(ownersOf(data.codeowners, f.path).owners) : '';

  // "files" moves through the list; "diff" puts a cursor in the diff to stage hunks and lines;
  // "conflict" (for a conflicted file) moves between its conflict blocks to take a side of each.
  const [paneState, setPane] = useState('files');
  const target = !f ? null : f.area === 'conflict' ? 'conflict' : 'diff';
  const pane = paneState === target ? paneState : 'files';
  const fileKey = f ? `${f.area}:${f.path}` : null;
  // v in the file list: the first row of a selection of files, to stash together (s).
  const [filesFrom, setFilesFrom] = useState(null);
  const fileSpan = filesFrom == null ? null : [Math.min(filesFrom, nav.index), Math.max(filesFrom, nav.index)];
  const selectedFiles = () => (fileSpan ? rows.slice(fileSpan[0], fileSpan[1] + 1).filter((r) => r.file).map((r) => r.file) : f ? [f] : []);
  const [anchor, setAnchor] = useState(null);
  const [anchorFor, setAnchorFor] = useState(null);
  if (anchorFor !== fileKey) {
    setAnchorFor(fileKey);
    setAnchor(null);
  }

  const diffKey = target === 'diff' && (split || pane === 'diff') ? `change:${data.root}:${fileKey}:${data.loadedAt}` : null;
  // A diff read for an older load is never asked for again, so once this one is on screen those go.
  const diff = useAsync(diffKey, () => changeDiff(data.root, f), 60, { stale: (k) => k.startsWith('change:') && !k.endsWith(`:${data.loadedAt}`) });
  const raw = diff.error ? diff.error.message : (diff.value ?? '');
  const parsed = useMemo(() => parseDiff(raw), [raw]);
  const dRows = useMemo(() => diffRows(parsed, raw), [parsed, raw]);
  const words = useMemo(() => wordChanges(dRows.map((r) => clean(r.text))), [dRows]);
  // The diff's rows on screen: one line each, or side by side the two sides of a pair, which the cursor
  // and a selection (v) take together. `units(i)` are the diff lines in row i.
  const sbs = sideBySide && target === 'diff';
  const layout = useMemo(() => (sbs ? splitView(dRows.map((r) => r.text)) : null), [dRows, sbs]);
  const shown = layout ? layout.view : dRows;
  const units = (i) => (layout ? (layout.view[i] ? rowLines(layout.view[i]) : []) : [i]);
  const changeIn = (i) => units(i).find((j) => dRows[j]?.change);
  const dnav = useListNav(shown.length, innerH, { selectable: (i) => changeIn(i) != null, resetKey: fileKey });
  // Switching between one column and two keeps the cursor on its line (and drops a selection).
  const curLine = useRef(0);
  const [shownSbs, setShownSbs] = useState(sbs);
  if (shownSbs !== sbs) {
    setShownSbs(sbs);
    setAnchor(null);
    dnav.setIndex(layout ? (layout.rowOf[curLine.current] ?? 0) : curLine.current);
  } else curLine.current = changeIn(dnav.index) ?? units(dnav.index)[0] ?? 0;
  // Never apply picks made on a diff that's stale (still loading after a change).
  const fresh = diff.key === diffKey && !diff.loading && !diff.error;

  const cur = dRows[changeIn(dnav.index) ?? units(dnav.index)[0]];
  const range = anchor == null ? null : [Math.min(anchor, dnav.index), Math.max(anchor, dnav.index)];
  const picks = () => {
    if (!cur?.change) return null;
    if (!range) return hunkPicks(parsed, cur.hunk);
    const map = new Map();
    for (let i = range[0]; i <= range[1]; i++) {
      for (const j of units(i)) {
        const r = dRows[j];
        if (!r?.change) continue;
        if (!map.has(r.hunk)) map.set(r.hunk, new Set());
        map.get(r.hunk).add(r.line);
      }
    }
    return map;
  };
  const jumpHunk = (dir) => {
    if (!cur) return;
    const target = shown.findIndex((_, i) => units(i).some((j) => dRows[j].change && dRows[j].hunk === cur.hunk + dir));
    if (target >= 0) dnav.setIndex(target);
  };

  const cf = useConflicts(data.root, f, data.loadedAt, split || pane === 'conflict', height);

  const fileKeys = (input, key) => {
    if (key.escape && fileSpan) return setFilesFrom(null);
    if (input === 'v') return setFilesFrom(fileSpan ? null : nav.index);
    if (input === 's' && fileSpan) {
      const list = selectedFiles();
      setFilesFrom(null);
      return a.stashFiles(ctx, list);
    }
    if (nav.handle(input, key)) return;
    if (input === 'J') return target === 'conflict' ? cf.page(1) : dnav.handle('', { pageDown: true });
    if (input === 'K') return target === 'conflict' ? cf.page(-1) : dnav.handle('', { pageUp: true });
    if (input === 'F') return a.fixup(ctx);
    if (input === 'Z') return a.absorb(ctx);
    if (sub) {
      if (input === 'I') return a.updateSubmodules(ctx, sub.path);
      if (input === 'o' || key.return) return a.openSubmodule(ctx, sub);
      return;
    }
    if (!f) return;
    if (input === ' ') return f.area === 'staged' ? a.unstage(ctx, f) : a.stage(ctx, f);
    if (key.return || key.rightArrow || input === 'l') return setPane(target);
    if (input === 'd' && f.area !== 'conflict') return a.discard(ctx, f);
    // A rename not committed yet has its history under the old name.
    if (input === 'H') return a.fileHistory(ctx, f.orig ?? f.path);
    if (input === 'B') return a.blame(ctx, f.path);
    if (input === 's') return a.stashFile(ctx, f);
    if (input === 'i') return a.ignoreFile(ctx, f);
    if (input === 'L') return a.lfsToggleLock(ctx, f);
    if (input === 'O' && f.area === 'conflict') return a.resolveWith(ctx, f, 'ours');
    if (input === 'T' && f.area === 'conflict') return a.resolveWith(ctx, f, 'theirs');
    if (input === 'C' && f.area === 'conflict') return a.claudeResolve(ctx, f);
  };

  const conflictKeys = async (input, key) => {
    if (key.escape || key.leftArrow || input === 'h') return setPane('files');
    if (key.downArrow || input === 'j' || input === 'n' || input === ']') return cf.move(1);
    if (key.upArrow || input === 'k' || input === 'N' || input === '[') return cf.move(-1);
    if (input === 'J' || key.pageDown || (key.ctrl && input === 'd')) return cf.page(1);
    if (input === 'K' || key.pageUp || (key.ctrl && input === 'u')) return cf.page(-1);
    if (input === 'C') return a.claudeResolve(ctx, f);
    const side = { o: 'ours', t: 'theirs', b: 'both' }[input];
    if (!side || !cf.file?.buf || !cf.count || cf.busy.current) return;
    cf.busy.current = true;
    const r = await a.resolveBlock(ctx, f, cf.file.buf, cf.block, side).finally(() => (cf.busy.current = false));
    if (!r) return;
    cf.written(r.buf);
    // Nothing more to pick here: back to the list, where space marks the file resolved.
    if (!r.left) setPane('files');
  };

  const diffKeys = async (input, key) => {
    if (key.escape || key.leftArrow || input === 'h') return anchor != null ? setAnchor(null) : setPane('files');
    if (dnav.handle(input, key)) return;
    if (input === 'n' || input === ']') return jumpHunk(1);
    if (input === 'N' || input === '[') return jumpHunk(-1);
    if (input === 'v') return setAnchor(anchor == null ? dnav.index : null);
    if (key.return) return ctx.showChange(f);
    if ((input === ' ' || input === 'd' || input === 's') && fresh) {
      const p = picks();
      if (!p) return;
      if (input === 's') await a.stashLines(ctx, f, raw, p);
      else await a.applyLines(ctx, f, raw, p, { discard: input === 'd' });
      setAnchor(null);
    }
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'w' && target === 'diff') return a.toggleSideBySide(ctx, { width, need: LIST_MIN + SPLIT_WIDTH });
    if (input === 'a') return a.stageAll(ctx);
    if (input === 'u') return a.unstageAll(ctx);
    if (input === 'c') return a.commit(ctx, '');
    if (input === 'A') return ctx.prefill('/amend ');
    // Started from what's typed after /commit or /amend in the prompt, if anything.
    if (input === 'M') return a.editMessage(ctx, promptMessage(ctx.promptText));
    if (input === 'W') return a.describeCommit(ctx);
    if (input === 'S') return a.claudeSplit(ctx);
    if (input === 'R') return a.claudeLook(ctx, 'review', { kind: 'changes' });
    if (input === 'y' && (f || sub)) return ctx.copy((f ?? sub).path);
    if (pane === 'conflict') return conflictKeys(input, key);
    return pane === 'diff' ? diffKeys(input, key) : fileKeys(input, key);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    const inDiff = split ? e.x >= listW : pane !== 'files';
    if (!inDiff) {
      if (e.wheel) return nav.scrollBy(e.wheel * 3);
      if (!nav.pick(e.y - 1)) return;
      if (pane !== 'files') setPane('files');
      // ↵ on a file: into its diff to pick hunks, or its conflict blocks.
      if (e.double) keys('', { return: true });
      return;
    }
    if (target === 'conflict') return e.wheel ? cf.page(e.wheel) : setPane('conflict');
    if (e.wheel) return dnav.scrollBy(e.wheel * 3);
    // A click on a + or - line puts the cursor there, to stage its hunk with space.
    if (target === 'diff' && dnav.pick(e.y - 1)) setPane('diff');
  });

  const showList = split || pane === 'files';
  const showDiff = split || pane !== 'files';
  const diffW = split ? width - listW : width;
  const verb = f?.area === 'staged' ? 'unstage' : 'stage';
  const diffHint = !f
    ? ''
    : pane === 'files'
      ? target === 'conflict'
        ? '↵ resolve block by block · J/K scroll'
        : `↵ pick hunks · J/K scroll`
      : pane === 'conflict'
        ? 'o ours · t theirs · b both · n/N · esc'
        : range
        ? `space ${verb} lines${f.area === 'unstaged' ? ' · d discard · s stash' : ''} · esc`
        : `space ${verb} hunk · v lines · n/N · esc`;
  const splitHint = target === 'diff' && split && width - LIST_MIN >= SPLIT_WIDTH ? (sideBySide ? ' · w one column' : ' · w side by side') : '';
  const listHint = fileSpan
    ? `${selectedFiles().length} selected · s stash`
    : f?.area === 'conflict'
      ? 'space resolved · O ours · T theirs · C Claude'
      : f?.kind === 'untracked'
        ? 'space stage · i ignore'
        : 'space stage/unstage · i ignore';

  return (
    <Box width={width} height={height}>
      {showList ? (
        <Panel title="Changes" hint={listHint} width={listW} height={height} focused={active && pane === 'files'}>
          {rows.slice(nav.offset, nav.offset + innerH).map((row, i) => {
            const idx = nav.offset + i;
            if (row.header) {
              return (
                <Row
                  key={`h${row.header}`}
                  width={listW - 2}
                  pointer={false}
                  segments={[
                    { text: row.header, bold: true, color: row.header === 'Conflicts' ? theme.del : undefined },
                    { text: ` (${row.count})`, color: theme.dim },
                  ]}
                />
              );
            }
            if (row.sub) {
              return <Row key={`s:${row.sub.path}`} width={listW - 2} selected={idx === nav.index} focused={active && pane === 'files'} segments={subSegments(row.sub)} />;
            }
            if (row.note) return <Row key={`n${idx}`} width={listW - 2} segments={[{ text: row.note, color: theme.dim, italic: true }]} />;
            return (
              <Row
                key={`${row.file.area}:${row.file.path}`}
                width={listW - 2}
                selected={idx === nav.index}
                marked={fileSpan && idx >= fileSpan[0] && idx <= fileSpan[1]}
                focused={active && pane === 'files'}
                segments={idx === nav.index && owned ? [...fileSegments(row.file, data.lfs?.files), { text: `  ${owned}`, color: theme.hunk }] : fileSegments(row.file, data.lfs?.files)}
              />
            );
          })}
        </Panel>
      ) : null}
      {showDiff && sub ? (
        <Panel title={sub.path} hint="I init/update · o open" width={diffW} height={height}>
          <Lines lines={subLines(sub)} width={diffW - 2} height={innerH} />
        </Panel>
      ) : showDiff && target === 'conflict' ? (
        <ConflictPane cf={cf} f={f} hint={diffHint} width={diffW} height={height} focused={active && pane === 'conflict'} />
      ) : showDiff ? (
        <Panel title={f ? `${f.path}${owned ? ` · ${owned}` : ''}` : 'Diff'} hint={diffHint + splitHint} width={diffW} height={height} focused={active && pane === 'diff'}>
          {!f ? <Row pointer={false} width={diffW - 2} segments={[{ text: 'Working tree clean.', color: theme.dim }]} /> : null}
          {f
            ? shown.slice(dnav.offset, dnav.offset + innerH).map((r, i) => {
                const idx = dnav.offset + i;
                const picking = pane === 'diff';
                const inPick = picking && (range ? idx >= range[0] && idx <= range[1] : cur && units(idx).some((j) => dRows[j].hunk === cur.hunk));
                const segs = layout && r.full == null ? pairSegments(r, dRows, words, layout.digits, diffW - 3) : diffSegments(dRows[units(idx)[0]].text, words.get(units(idx)[0]));
                return (
                  <Row
                    key={idx}
                    width={diffW - 2}
                    pointer={false}
                    selected={picking && (range ? inPick && changeIn(idx) != null : idx === dnav.index)}
                    segments={[{ text: inPick ? '▌' : ' ', color: theme.accent }, ...segs]}
                  />
                );
              })
            : null}
        </Panel>
      ) : null}
    </Box>
  );
}
