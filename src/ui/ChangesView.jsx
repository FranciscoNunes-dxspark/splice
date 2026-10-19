import React, { useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import { dirname, basename } from 'node:path/posix';
import * as a from '../actions.js';
import { changeDiff } from '../repo.js';
import { codeColor, theme } from '../theme.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row, diffSegment } from './parts.jsx';

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
  const diffW = width - listW;
  const innerH = height - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.file), resetKey: data.root });
  const f = rows[nav.index]?.file;

  const [diffOffset, setDiffOffset] = useState(0);
  const fileKey = f ? `${f.area}:${f.path}` : null;
  const [diffFor, setDiffFor] = useState(null);
  if (diffFor !== fileKey) {
    setDiffFor(fileKey);
    setDiffOffset(0);
  }
  const diff = useAsync(f && split ? `change:${data.root}:${fileKey}:${data.loadedAt}` : null, () => changeDiff(data.root, f));

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'a') return a.stageAll(ctx);
      if (input === 'u') return a.unstageAll(ctx);
      if (input === 'c') return a.commit(ctx, '');
      if (input === 'A') return ctx.prefill('/amend ');
      if (input === 'J') return setDiffOffset((o) => o + 5);
      if (input === 'K') return setDiffOffset((o) => Math.max(0, o - 5));
      if (!f) return;
      if (input === ' ') return f.area === 'staged' ? a.unstage(ctx, f) : a.stage(ctx, f);
      if (key.return) return ctx.showChange(f);
      if (input === 'd' && f.area !== 'conflict') return a.discard(ctx, f);
      if (input === 'O' && f.area === 'conflict') return a.resolveWith(ctx, f, 'ours');
      if (input === 'T' && f.area === 'conflict') return a.resolveWith(ctx, f, 'theirs');
    },
    { isActive: active },
  );

  // The preview starts at the first hunk; the full header is one ↵ away.
  let diffLines = (diff.value ?? '').split('\n');
  const firstHunk = diffLines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk > 0) diffLines = diffLines.slice(firstHunk);
  if (diff.error) diffLines = [diff.error.message];

  const hint = f?.area === 'conflict' ? 'space resolved · O ours · T theirs' : 'space stage/unstage';
  return (
    <Box width={width} height={height}>
      <Panel title="Changes" hint={hint} width={listW} height={height} focused={active}>
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
            <Row key={`${row.file.area}:${row.file.path}`} width={listW - 2} selected={idx === nav.index} focused={active} segments={fileSegments(row.file)} />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={f ? f.path : 'Diff'} hint={f ? '↵ full diff · J/K scroll' : ''} width={diffW} height={height}>
          {f ? (
            <Lines width={diffW - 2} height={innerH} offset={diffOffset} lines={diffLines.map((l) => [diffSegment(l)])} />
          ) : (
            <Row pointer={false} width={diffW - 2} segments={[{ text: 'Working tree clean.', color: theme.dim }]} />
          )}
        </Panel>
      ) : null}
    </Box>
  );
}
