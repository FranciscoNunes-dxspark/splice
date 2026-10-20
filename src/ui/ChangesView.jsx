import React, { useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import { dirname, basename } from 'node:path/posix';
import * as a from '../actions.js';
import { hunkPicks, isChange, parseDiff } from '../patch.js';
import { changeDiff } from '../repo.js';
import { wordChanges } from '../search.js';
import { codeColor, theme } from '../theme.js';
import { clean } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Panel, Row, diffSegments } from './parts.jsx';
import { ConflictPane, useConflicts } from './ConflictPane.jsx';

function fileSegments(f) {
  const dir = dirname(f.path);
  const segs = [
    { text: `${f.code} `, color: codeColor(f.code), bold: true },
    { text: dir === '.' ? '' : `${dir}/`, color: theme.dim },
    { text: basename(f.path), strong: true },
  ];
  if (f.orig && f.area === 'staged') segs.push({ text: `  ← ${f.orig}`, color: theme.dim });
  return segs;
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
    return out;
  }, [data.changes]);

  const split = width >= 90;
  const listW = split ? Math.max(36, Math.floor(width * 0.4)) : width;
  const innerH = height - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.file), resetKey: data.root });
  const f = rows[nav.index]?.file;

  // "files" moves through the list; "diff" puts a cursor in the diff to stage hunks and lines;
  // "conflict" (for a conflicted file) moves between its conflict blocks to take a side of each.
  const [paneState, setPane] = useState('files');
  const target = !f ? null : f.area === 'conflict' ? 'conflict' : 'diff';
  const pane = paneState === target ? paneState : 'files';
  const fileKey = f ? `${f.area}:${f.path}` : null;
  const [anchor, setAnchor] = useState(null);
  const [anchorFor, setAnchorFor] = useState(null);
  if (anchorFor !== fileKey) {
    setAnchorFor(fileKey);
    setAnchor(null);
  }

  const diffKey = target === 'diff' && (split || pane === 'diff') ? `change:${data.root}:${fileKey}:${data.loadedAt}` : null;
  const diff = useAsync(diffKey, () => changeDiff(data.root, f));
  const raw = diff.error ? diff.error.message : (diff.value ?? '');
  const parsed = useMemo(() => parseDiff(raw), [raw]);
  const dRows = useMemo(() => diffRows(parsed, raw), [parsed, raw]);
  const words = useMemo(() => wordChanges(dRows.map((r) => clean(r.text))), [dRows]);
  const dnav = useListNav(dRows.length, innerH, { selectable: (i) => Boolean(dRows[i]?.change), resetKey: fileKey });
  // Never apply picks made on a diff that's stale (still loading after a change).
  const fresh = diff.key === diffKey && !diff.loading && !diff.error;

  const cur = dRows[dnav.index];
  const range = anchor == null ? null : [Math.min(anchor, dnav.index), Math.max(anchor, dnav.index)];
  const picks = () => {
    if (!cur?.change) return null;
    if (!range) return hunkPicks(parsed, cur.hunk);
    const map = new Map();
    for (let i = range[0]; i <= range[1]; i++) {
      const r = dRows[i];
      if (!r?.change) continue;
      if (!map.has(r.hunk)) map.set(r.hunk, new Set());
      map.get(r.hunk).add(r.line);
    }
    return map;
  };
  const jumpHunk = (dir) => {
    if (!cur) return;
    const target = dRows.findIndex((r) => r.change && r.hunk === cur.hunk + dir);
    if (target >= 0) dnav.setIndex(target);
  };

  const cf = useConflicts(data.root, f, data.loadedAt, split || pane === 'conflict', height);

  const fileKeys = (input, key) => {
    if (nav.handle(input, key)) return;
    if (input === 'J') return target === 'conflict' ? cf.page(1) : dnav.handle('', { pageDown: true });
    if (input === 'K') return target === 'conflict' ? cf.page(-1) : dnav.handle('', { pageUp: true });
    if (input === 'F') return a.fixup(ctx);
    if (!f) return;
    if (input === ' ') return f.area === 'staged' ? a.unstage(ctx, f) : a.stage(ctx, f);
    if (key.return || key.rightArrow || input === 'l') return setPane(target);
    if (input === 'd' && f.area !== 'conflict') return a.discard(ctx, f);
    // A rename not committed yet has its history under the old name.
    if (input === 'H') return a.fileHistory(ctx, f.orig ?? f.path);
    if (input === 'B') return a.blame(ctx, f.path);
    if (input === 's') return a.stashFile(ctx, f);
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
    if ((input === ' ' || input === 'd') && fresh) {
      const p = picks();
      if (!p) return;
      await a.applyLines(ctx, f, raw, p, { discard: input === 'd' });
      setAnchor(null);
    }
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'a') return a.stageAll(ctx);
    if (input === 'u') return a.unstageAll(ctx);
    if (input === 'c') return a.commit(ctx, '');
    if (input === 'A') return ctx.prefill('/amend ');
    if (input === 'W') return a.describeCommit(ctx);
    if (input === 'R') return a.claudeLook(ctx, 'review', { kind: 'changes' });
    if (input === 'y' && f) return ctx.copy(f.path);
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
        ? `space ${verb} lines${f.area === 'unstaged' ? ' · d discard' : ''} · esc`
        : `space ${verb} hunk · v lines · n/N · esc`;
  const listHint = f?.area === 'conflict' ? 'space resolved · O ours · T theirs · C Claude' : 'space stage/unstage';

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
            if (row.note) return <Row key={`n${idx}`} width={listW - 2} segments={[{ text: row.note, color: theme.dim, italic: true }]} />;
            return (
              <Row
                key={`${row.file.area}:${row.file.path}`}
                width={listW - 2}
                selected={idx === nav.index}
                focused={active && pane === 'files'}
                segments={fileSegments(row.file)}
              />
            );
          })}
        </Panel>
      ) : null}
      {showDiff && target === 'conflict' ? (
        <ConflictPane cf={cf} f={f} hint={diffHint} width={diffW} height={height} focused={active && pane === 'conflict'} />
      ) : showDiff ? (
        <Panel title={f ? f.path : 'Diff'} hint={diffHint} width={diffW} height={height} focused={active && pane === 'diff'}>
          {!f ? <Row pointer={false} width={diffW - 2} segments={[{ text: 'Working tree clean.', color: theme.dim }]} /> : null}
          {f
            ? dRows.slice(dnav.offset, dnav.offset + innerH).map((r, i) => {
                const idx = dnav.offset + i;
                const picking = pane === 'diff';
                const inPick = picking && (range ? idx >= range[0] && idx <= range[1] : cur && r.hunk === cur.hunk);
                return (
                  <Row
                    key={idx}
                    width={diffW - 2}
                    pointer={false}
                    selected={picking && (range ? inPick && r.change : idx === dnav.index)}
                    segments={[{ text: inPick ? '▌' : ' ', color: theme.accent }, ...diffSegments(r.text, words.get(idx))]}
                  />
                );
              })
            : null}
        </Panel>
      ) : null}
    </Box>
  );
}
