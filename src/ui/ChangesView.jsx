import React, { useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import { dirname, basename } from 'node:path/posix';
import * as a from '../actions.js';
import { hunkPicks, isChange, parseDiff } from '../patch.js';
import { changeDiff } from '../repo.js';
import { codeColor, theme } from '../theme.js';
import { useAsync, useListNav } from './hooks.js';
import { Panel, Row, diffSegment } from './parts.jsx';

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

  // "files" moves through the list; "diff" puts a cursor in the diff to stage hunks and lines.
  const [paneState, setPane] = useState('files');
  const canPick = Boolean(f) && f.area !== 'conflict';
  const pane = canPick ? paneState : 'files';
  const fileKey = f ? `${f.area}:${f.path}` : null;
  const [anchor, setAnchor] = useState(null);
  const [anchorFor, setAnchorFor] = useState(null);
  if (anchorFor !== fileKey) {
    setAnchorFor(fileKey);
    setAnchor(null);
  }

  const diffKey = f && (split || pane === 'diff') ? `change:${data.root}:${fileKey}:${data.loadedAt}` : null;
  const diff = useAsync(diffKey, () => changeDiff(data.root, f));
  const raw = diff.error ? diff.error.message : (diff.value ?? '');
  const parsed = useMemo(() => parseDiff(raw), [raw]);
  const dRows = useMemo(() => diffRows(parsed, raw), [parsed, raw]);
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

  const fileKeys = (input, key) => {
    if (nav.handle(input, key)) return;
    if (input === 'J') return dnav.handle('', { pageDown: true });
    if (input === 'K') return dnav.handle('', { pageUp: true });
    if (!f) return;
    if (input === ' ') return f.area === 'staged' ? a.unstage(ctx, f) : a.stage(ctx, f);
    if ((key.return || key.rightArrow || input === 'l') && canPick) return setPane('diff');
    if (key.return) return ctx.showChange(f);
    if (input === 'd' && f.area !== 'conflict') return a.discard(ctx, f);
    if (input === 'O' && f.area === 'conflict') return a.resolveWith(ctx, f, 'ours');
    if (input === 'T' && f.area === 'conflict') return a.resolveWith(ctx, f, 'theirs');
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

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (input === 'a') return a.stageAll(ctx);
      if (input === 'u') return a.unstageAll(ctx);
      if (input === 'c') return a.commit(ctx, '');
      if (input === 'A') return ctx.prefill('/amend ');
      return pane === 'diff' ? diffKeys(input, key) : fileKeys(input, key);
    },
    { isActive: active },
  );

  const showList = split || pane === 'files';
  const showDiff = split || pane === 'diff';
  const diffW = split ? width - listW : width;
  const verb = f?.area === 'staged' ? 'unstage' : 'stage';
  const diffHint = !f
    ? ''
    : pane === 'files'
      ? canPick
        ? `↵ pick hunks · J/K scroll`
        : 'J/K scroll'
      : range
        ? `space ${verb} lines${f.area === 'unstaged' ? ' · d discard' : ''} · esc`
        : `space ${verb} hunk · v lines · n/N · esc`;
  const listHint = f?.area === 'conflict' ? 'space resolved · O ours · T theirs' : 'space stage/unstage';

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
      {showDiff ? (
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
                    segments={[{ text: inPick ? '▌' : ' ', color: theme.accent }, diffSegment(r.text)]}
                  />
                );
              })
            : null}
        </Panel>
      ) : null}
    </Box>
  );
}
