import React, { useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { commitDetail } from '../repo.js';
import { codeColor, theme } from '../theme.js';
import { fit, fitSegments, wrap } from '../text.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

// git draws lanes two columns apart; diagonals sit between them and belong to the lane they lead to.
function laneColor(col, ch) {
  const lane = ch === '|' || ch === '*' ? col / 2 : Math.ceil(col / 2);
  return theme.lanes[Math.floor(lane) % theme.lanes.length];
}

/** Colours git's ASCII graph by lane and swaps in nicer glyphs, padded to `width`. */
export function graphSegments(graph, width) {
  const g = graph.length > width ? `${graph.slice(0, Math.max(0, width - 1))}…` : graph.padEnd(width);
  const segs = [];
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    const glyph = ch === '*' ? '●' : ch === '|' ? '│' : ch;
    const color = ch === ' ' || ch === '…' ? undefined : laneColor(i, ch);
    const bold = ch === '*';
    const last = segs.at(-1);
    if (last && last.color === color && last.bold === bold) last.text += glyph;
    else segs.push({ text: glyph, color, bold });
  }
  return segs;
}

/** Branch and tag labels as coloured pills. A local branch absorbs its remote twins: "main ⇅ origin". */
export function refPills(refs) {
  const segs = [];
  const pill = (text, bg) => segs.push({ text: ` ${text} `, bg, color: theme.ink, bold: true }, { text: ' ' });
  const absorbed = new Set();
  if (refs.some((r) => r.type === 'head')) pill('HEAD', theme.warn);
  for (const r of refs.filter((x) => x.type === 'local')) {
    const twins = refs.filter((o) => o.type === 'remote' && o.name.endsWith(`/${r.name}`));
    twins.forEach((t) => absorbed.add(t.name));
    const remotes = twins.map((t) => t.name.slice(0, -r.name.length - 1));
    pill(`${r.head ? '● ' : ''}${r.name}${remotes.length ? ` ⇅ ${remotes.join(',')}` : ''}`, r.head ? theme.accent : theme.local);
  }
  for (const r of refs.filter((x) => x.type === 'remote' && !absorbed.has(x.name))) pill(r.name, theme.remote);
  for (const r of refs.filter((x) => x.type === 'tag')) pill(r.name, theme.tag);
  return segs;
}

const META_W = 26;

function detailLines(c, d, width) {
  const lines = [
    [
      { text: c.hash.slice(0, 10), color: theme.warn, bold: true },
      { text: `  ${new Date(c.time * 1000).toLocaleString()}`, color: theme.dim },
    ],
    [{ text: c.author, bold: true }, { text: d?.email ? ` <${d.email}>` : '', color: theme.dim }],
  ];
  if (c.parents.length > 1) lines.push([{ text: `Merge of ${c.parents.map((p) => p.slice(0, 7)).join(' + ')}`, color: theme.dim }]);
  if (c.refs.length) lines.push(refPills(c.refs));
  lines.push('');
  const [subject, ...body] = (d?.message ?? c.subject).split('\n');
  for (const l of wrap(subject, width)) lines.push([{ text: l, bold: true }]);
  while (body.length && !body[0].trim()) body.shift();
  if (body.length) {
    lines.push('');
    for (const l of wrap(body.join('\n'), width)) lines.push(l);
  }
  lines.push('');
  if (!d) lines.push([{ text: 'Loading…', color: theme.dim }]);
  else {
    lines.push([{ text: `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`, color: theme.dim }]);
    for (const f of d.files) {
      lines.push([
        { text: `${f.code} `, color: codeColor(f.code), bold: true },
        { text: f.orig ? `${f.orig} → ${f.path}` : f.path },
      ]);
    }
  }
  return lines;
}

export function GraphView({ data, ctx, width, height, active, filter }) {
  const rows = useMemo(() => {
    if (filter) {
      const q = filter.toLowerCase();
      return data.graph.filter(
        ({ commit: c }) =>
          c &&
          (c.subject.toLowerCase().includes(q) ||
            c.author.toLowerCase().includes(q) ||
            c.hash.startsWith(q) ||
            c.refs.some((r) => r.name.toLowerCase().includes(q))),
      );
    }
    const dirty = data.status.files.length;
    return dirty ? [{ wip: dirty }, ...data.graph] : data.graph;
  }, [data, filter]);

  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const detailW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, {
    selectable: (i) => Boolean(rows[i]?.commit || rows[i]?.wip),
    resetKey: `${data.root}|${filter}`,
  });
  const sel = rows[nav.index];
  const c = sel?.commit;
  const [detailOffset, setDetailOffset] = useState(0);
  const [detailFor, setDetailFor] = useState(null);
  if (detailFor !== (c?.hash ?? null)) {
    setDetailFor(c?.hash ?? null);
    setDetailOffset(0);
  }
  const detail = useAsync(c && split ? `detail:${data.root}:${c.hash}` : null, () => commitDetail(data.root, c.hash));

  const graphW = filter ? 0 : Math.min(Math.floor(innerW * 0.35), Math.max(1, ...data.graph.map((r) => r.graph.length)));
  const metaOn = innerW >= 70;
  const budget = innerW - 2 - (metaOn ? META_W : 0);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) {
        if (!filter && !data.graphComplete && nav.index > rows.length - innerH - 5) ctx.loadMore();
        return;
      }
      if (key.escape && filter) return ctx.find('');
      if (input === 'J') return setDetailOffset((o) => o + 3);
      if (input === 'K') return setDetailOffset((o) => Math.max(0, o - 3));
      if (sel?.wip) {
        if (key.return) ctx.setView('changes');
        return;
      }
      if (!c) return;
      const short = c.hash.slice(0, 7);
      const ref = c.refs.find((r) => r.type === 'local')?.name ?? c.refs.find((r) => r.type === 'remote')?.name ?? c.hash;
      if (key.return) ctx.showPatch(c);
      else if (input === 'c') a.checkoutCommit(ctx, c);
      else if (input === 'b') ctx.prefill(`/branch  ${short}`, 8);
      else if (input === 't') ctx.prefill(`/tag  ${short}`, 5);
      else if (input === 'm') a.merge(ctx, ref, { ask: true });
      else if (input === 'C') a.cherryPick(ctx, c);
      else if (input === 'v') a.revert(ctx, c);
      else if (input === 'X') a.reset(ctx, c.hash, short);
    },
    { isActive: active },
  );

  const visible = rows.slice(nav.offset, nav.offset + innerH);
  const commits = rows.filter((r) => r.commit).length;
  const title = filter ? `Commits matching "${filter}" (${commits})` : 'Commits';
  const hint = filter ? 'esc clears' : data.graphComplete ? `${commits}` : `${commits}+`;

  return (
    <Box width={width} height={height}>
      <Panel title={title} hint={hint} width={listW} height={height} focused={active}>
        {rows.length === 0 ? (
          <Row pointer={false} width={innerW} segments={[{ text: filter ? '  No loaded commit matches.' : '  No commits yet.', color: theme.dim }]} />
        ) : null}
        {visible.map((row, i) => {
          const selected = nav.offset + i === nav.index;
          if (row.wip) {
            return (
              <Row
                key="wip"
                width={innerW}
                selected={selected}
                focused={active}
                segments={fitSegments(
                  [
                    { text: fit('◌', graphW), color: theme.accent, bold: true },
                    { text: ' ' },
                    { text: ' // WIP ', color: theme.accent, bold: true },
                    { text: ` ${row.wip} changed file${row.wip === 1 ? '' : 's'}`, color: theme.dim },
                  ],
                  budget,
                )}
              />
            );
          }
          if (!row.commit) {
            return <Row key={`g${nav.offset + i}`} width={innerW} segments={graphSegments(row.graph, graphW)} />;
          }
          const k = row.commit;
          const left = [
            ...(graphW ? graphSegments(row.graph, graphW) : []),
            { text: ' ' },
            ...refPills(k.refs),
            { text: k.subject, strong: true },
          ];
          const meta = metaOn
            ? [
                { text: ` ${fit(k.author, 12)}`, color: theme.dim },
                { text: ` ${fit(relTime(k.time), 4, 'right')}`, color: theme.dim },
                { text: ` ${k.hash.slice(0, 7)}`, color: theme.warn },
              ]
            : [];
          return (
            <Row key={k.hash} width={innerW} selected={selected} focused={active} segments={[...fitSegments(left, budget), ...meta]} />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={sel?.wip ? 'Working tree' : 'Commit'} hint={c ? 'J/K scroll' : ''} width={detailW} height={height}>
          {c ? (
            <Lines lines={detailLines(c, detail.value?.hash === c.hash ? detail.value : null, detailW - 4)} width={detailW - 2} height={innerH} offset={detailOffset} />
          ) : sel?.wip ? (
            <Lines
              width={detailW - 2}
              height={innerH}
              lines={[
                [{ text: `${sel.wip} uncommitted change${sel.wip === 1 ? '' : 's'}`, bold: true }],
                '',
                ...data.status.files.map((f) => [
                  { text: `${f.kind === 'untracked' ? '?' : f.x !== '.' ? f.x : f.y} `, color: codeColor(f.kind === 'untracked' ? '?' : f.x !== '.' ? f.x : f.y), bold: true },
                  { text: f.path },
                ]),
                '',
                [{ text: 'Press ↵ to stage and commit in Changes.', color: theme.dim }],
              ]}
            />
          ) : null}
        </Panel>
      ) : null}
    </Box>
  );
}
