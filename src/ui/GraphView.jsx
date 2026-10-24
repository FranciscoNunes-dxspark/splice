import React, { useEffect, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { commitDetail, commitSignature } from '../repo.js';
import { signatureLine } from '../signing.js';
import { codeColor, theme } from '../theme.js';
import { fit, fitSegments, wrap } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/** A row's graph cells (from `layoutGraph`) as segments, cut or padded to `width`. */
export function graphSegments(cells, width) {
  const g = cells.length > width ? [...cells.slice(0, Math.max(0, width - 1)), { ch: '…' }] : cells;
  const segs = [];
  for (const { ch, color, node = false } of g) {
    const last = segs.at(-1);
    if (last && last.color === color && last.bold === node) last.text += ch;
    else segs.push({ text: ch, color, bold: node });
  }
  if (g.length < width) segs.push({ text: ' '.repeat(width - g.length) });
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
  for (const r of refs.filter((x) => x.type === 'bisect')) pill(r.name, { bad: theme.del, good: theme.add }[r.name] ?? theme.dim);
  return segs;
}

const META_W = 26;
// Getters, so the colours are the theme's as it is now (light or dark).
const SIG_TONE = { get good() { return theme.add; }, get wait() { return theme.warn; }, get bad() { return theme.del; }, get none() { return theme.dim; } };

// `sig`: the commit's signature, read only with Show signatures on (undefined when off, null while it's read).
function detailLines(c, d, width, sig) {
  const lines = [
    [
      { text: c.hash.slice(0, 10), color: theme.warn, bold: true },
      { text: `  ${new Date(c.time * 1000).toLocaleString()}`, color: theme.dim },
    ],
    [{ text: c.author, bold: true }, { text: d?.email ? ` <${d.email}>` : '', color: theme.dim }],
  ];
  if (sig === null) lines.push([{ text: 'Checking the signature…', color: theme.dim }]);
  else if (sig) {
    const l = signatureLine(sig);
    const icon = { Good: '✓ ', Bad: '✗ ', None: '', Unknown: '? ', Expired: '! ' }[l.word];
    lines.push([{ text: `${icon}${l.word}: `, color: SIG_TONE[l.tone], bold: true }, { text: l.text, color: SIG_TONE[l.tone] }]);
  }
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

/** The graph's title and empty-list line for a filter: text over the loaded commits, or a -S / -G search of the history. */
export function filterTitle(filter, count) {
  const { mode, query } = filter;
  if (mode === 'S') return { title: `Commits adding or removing "${query}" (${count})`, empty: 'No commit in the history adds or removes it.' };
  if (mode === 'F') return { title: `Commits ${query} (${count})`, empty: 'No commit on any branch matches the filter.' };
  if (mode === 'G') return { title: `Commits changing lines that match /${query}/ (${count})`, empty: 'No commit in the history changes a line that matches.' };
  return { title: `Commits matching "${query}" (${count})`, empty: 'No loaded commit matches.' };
}

export function GraphView({ data, ctx, width, height, active, filter, jump }) {
  const rows = useMemo(() => {
    // A history search (/find -S or -G) brought its own commits.
    if (filter?.rows) return filter.rows;
    if (filter) {
      const q = filter.query.toLowerCase();
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
    resetKey: `${data.root}|${filter ? `${filter.mode}:${filter.query}` : ''}`,
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
  // Show signatures (off unless set): %G? has git check the signature, so only the commit under the cursor's.
  const signatures = ctx.config?.showSignatures === true;
  const sigKey = c && split && signatures ? `sig:${data.root}:${c.hash}` : null;
  const sig = useAsync(sigKey, () => commitSignature(data.root, c.hash));
  // A signature that couldn't be read (no gpg) is one that can't be checked here.
  const sigShown = !sigKey ? undefined : sig.key !== sigKey ? null : (sig.value ?? (sig.error ? { code: 'E', signer: '', key: '' } : null));

  // While bisecting, the cursor follows HEAD: the commit git just checked out to try.
  const head = data.status.branch.oid;
  useEffect(() => {
    if (data.state !== 'bisecting' || filter) return;
    const at = rows.findIndex((r) => r.commit?.hash === head);
    if (at >= 0) nav.setIndex(at);
  }, [data.state, head]);

  // A commit something asked to show (ctx.showInGraph): the cursor goes to it once it's among the rows.
  useEffect(() => {
    const want = ctx.pendingJump;
    if (!want) return;
    const at = want.root === data.root ? rows.findIndex((r) => r.commit?.hash === want.hash) : -1;
    if (at >= 0) nav.setIndex(at);
    // Another repository's commit is never coming.
    if (at >= 0 || want.root !== data.root) ctx.pendingJump = null;
  }, [jump, rows]);

  // V: the commit the selection started on, by hash, so it stays put when a reload adds rows above it.
  const [fromHash, setFromHash] = useState(null);
  const fromIndex = fromHash ? rows.findIndex((r) => r.commit?.hash === fromHash) : -1;
  const span = fromIndex < 0 ? null : [Math.min(fromIndex, nav.index), Math.max(fromIndex, nav.index)];
  // Newest first, as drawn.
  const picked = span ? rows.slice(span[0], span[1] + 1).filter((r) => r.commit).map((r) => r.commit) : [];

  // The widest graph and the commits among the rows: passes over every loaded row, done when they change rather than on every key.
  const widest = useMemo(() => data.graph.reduce((w, r) => Math.max(w, r.graph.length), 1), [data.graph]);
  const commits = useMemo(() => rows.reduce((n, r) => n + (r.commit ? 1 : 0), 0), [rows]);
  const graphW = filter ? 0 : Math.min(Math.floor(innerW * 0.35), widest);
  const metaOn = innerW >= 70;
  const budget = innerW - 2 - (metaOn ? META_W : 0);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) {
      if (!filter && !data.graphComplete && nav.index > rows.length - innerH - 5) ctx.loadMore();
      return;
    }
    if (key.escape && span) return setFromHash(null);
    if (input === 'C' && span) {
      setFromHash(null);
      // Oldest first, the order they're picked in.
      return a.cherryPickMany(ctx, [...picked].reverse());
    }
    if (key.escape && filter) return ctx.find('');
    if (input === 'J') return setDetailOffset((o) => o + 3);
    if (input === 'K') return setDetailOffset((o) => Math.max(0, o - 3));
    if (sel?.wip) {
      if (key.return) ctx.setView('changes');
      else if (input === 'R') a.claudeLook(ctx, 'review', { kind: 'changes' });
      return;
    }
    if (!c) return;
    if (input === 'V') return setFromHash(span ? null : c.hash);
    const short = c.hash.slice(0, 7);
    const ref = c.refs.find((r) => r.type === 'local')?.name ?? c.refs.find((r) => r.type === 'remote')?.name ?? c.hash;
    if (key.return) ctx.showPatch(c);
    else if (input === 'y') ctx.copy(c.hash, `the hash of ${short}`);
    else if (input === 'c') a.checkoutCommit(ctx, c);
    else if (input === 'b') ctx.prefill(`/branch  ${short}`, 8);
    else if (input === 't') ctx.prefill(`/tag  ${short}`, 5);
    else if (input === 'm') a.merge(ctx, ref, { ask: true });
    else if (input === 'C') a.cherryPick(ctx, c);
    else if (input === 'v') a.revert(ctx, c);
    else if (input === 'X') a.reset(ctx, c.hash, short);
    else if (input === 'B') a.bisectMark(ctx, c);
    else if (input === 'w') a.runAt(ctx, c.hash);
    else if (input === 'Y') a.shareCommit(ctx, c);
    // From this commit (included) up to HEAD.
    else if (input === 'i') a.openRebase(ctx, c.parents[0] ?? null, short);
    else if (input === 'e' || input === 'R') a.claudeLook(ctx, input === 'e' ? 'explain' : 'review', { kind: 'commit', hash: c.hash, subject: c.subject });
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (split && e.x >= listW) return e.wheel && setDetailOffset((o) => Math.max(0, o + e.wheel * 3));
    if (e.wheel) {
      nav.scrollBy(e.wheel * 3);
      if (e.wheel > 0 && !filter && !data.graphComplete && nav.offset + innerH > rows.length - 10) ctx.loadMore();
      return;
    }
    // Rows start under the panel's top border. A double-click does what ↵ does.
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const visible = rows.slice(nav.offset, nav.offset + innerH);
  const filtered = filter ? filterTitle(filter, commits) : { title: 'Commits', empty: 'No commits yet.' };
  const hint = span
    ? `${picked.length} selected · C cherry-pick · esc`
    : filter
      ? 'esc clears'
      : data.graphComplete
        ? `${commits}`
        : `${commits}+`;

  return (
    <Box width={width} height={height}>
      <Panel title={filtered.title} hint={hint} width={listW} height={height} focused={active}>
        {rows.length === 0 ? <Row pointer={false} width={innerW} segments={[{ text: `  ${filtered.empty}`, color: theme.dim }]} /> : null}
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
                    ...graphSegments(data.graphWip ?? [{ ch: '◌', color: theme.accent, node: true }], graphW),
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
            const inSpan = span && nav.offset + i > span[0] && nav.offset + i < span[1];
            return <Row key={`g${nav.offset + i}`} width={innerW} marked={inSpan} focused={active} segments={graphSegments(row.graph, graphW)} />;
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
            <Row
              key={k.hash}
              width={innerW}
              selected={selected}
              marked={span && nav.offset + i >= span[0] && nav.offset + i <= span[1]}
              focused={active}
              segments={[...fitSegments(left, budget), ...meta]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={sel?.wip ? 'Working tree' : 'Commit'} hint={c ? 'J/K scroll' : ''} width={detailW} height={height}>
          {c ? (
            <Lines lines={detailLines(c, detail.value?.hash === c.hash ? detail.value : null, detailW - 4, sigShown)} width={detailW - 2} height={innerH} offset={detailOffset} />
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
