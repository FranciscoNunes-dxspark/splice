import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConflicts } from '../conflict.js';
import { theme } from '../theme.js';
import { Panel, Row } from './parts.jsx';

// Lines of the file shown above and below each block.
const CONTEXT = 3;

/**
 * The conflict blocks as rows: a title, a little context, then each side under its label.
 * `tops[i]` is the row block i starts at.
 */
export function conflictRows({ lines, blocks }) {
  const rows = [];
  const tops = [];
  let shownTo = 0;
  blocks.forEach((b, bi) => {
    if (bi) rows.push({ kind: 'gap' });
    tops.push(rows.length);
    rows.push({ kind: 'title', block: bi, text: `Conflict ${bi + 1} of ${blocks.length} · line ${b.start + 1}` });
    for (let i = Math.max(shownTo, b.start - CONTEXT); i < b.start; i++) rows.push({ kind: 'context', text: lines[i].text });
    const side = (name, label, [from, to]) => {
      rows.push({ kind: 'label', side: name, text: label, block: bi });
      for (let i = from; i < to; i++) rows.push({ kind: 'line', side: name, text: lines[i].text, block: bi });
      if (from === to) rows.push({ kind: 'empty', side: name, block: bi });
    };
    side('ours', b.oursLabel, b.ours);
    if (b.base) side('base', b.baseLabel, b.base);
    side('theirs', b.theirsLabel, b.theirs);
    shownTo = Math.min(b.end + 1 + CONTEXT, blocks[bi + 1]?.start ?? lines.length);
    for (let i = b.end + 1; i < shownTo; i++) rows.push({ kind: 'context', text: lines[i].text });
  });
  return { rows, tops };
}

/**
 * A conflicted file's blocks, read from the working tree, with a cursor on one block.
 * `enabled` false (another kind of file, or the pane hidden) reads nothing.
 */
export function useConflicts(root, f, loadedAt, enabled, height) {
  const path = enabled && f?.area === 'conflict' ? f.path : null;
  const id = path ? `${root}\0${path}` : null;
  const [file, setFile] = useState(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    readFile(join(root, path)).then(
      (buf) => live && setFile({ id, buf }),
      (error) => live && setFile({ id, error }),
    );
    return () => {
      live = false;
    };
  }, [id, loadedAt]);
  // Until the new file is read, the last one's content isn't shown under its name.
  const current = file?.id === id ? file : null;
  const parsed = useMemo(() => (current?.buf ? parseConflicts(current.buf.toString('utf8')) : null), [current]);
  const { rows, tops } = useMemo(() => (parsed ? conflictRows(parsed) : { rows: [], tops: [] }), [parsed]);

  const [state, setState] = useState({ id: null, block: 0, scroll: 0 });
  const nav = state.id === id ? state : { id, block: 0, scroll: 0 };
  const count = parsed?.blocks.length ?? 0;
  const block = Math.max(0, Math.min(nav.block, count - 1));
  const innerH = Math.max(1, height - 2);
  const max = Math.max(0, rows.length - innerH);
  const top = tops[block] ?? 0;
  const offset = Math.max(0, Math.min(max, top + nav.scroll));
  // Set while a side is being written, so a second key doesn't act on the content from before it.
  const busy = useRef(false);

  return {
    file: current,
    busy,
    rows,
    count,
    block,
    offset,
    /** Next (1) or previous (-1) block, shown from its top. */
    move: (dir) => setState({ id, block: Math.max(0, Math.min(count - 1, block + dir)), scroll: 0 }),
    /** Scrolls a page down (1) or up (-1), for blocks taller than the pane. */
    page: (dir) => setState({ id, block, scroll: Math.max(0, Math.min(max, offset + dir * Math.max(1, innerH - 1))) - top }),
    /** Shows `buf` as the file's content straight away, until the next read. */
    written: (buf) => setFile({ id, buf }),
  };
}

const SIDES = {
  ours: () => ({ name: 'ours', color: theme.local }),
  base: () => ({ name: 'base', color: theme.warn }),
  theirs: () => ({ name: 'theirs', color: theme.remote }),
};

function rowSegments(r) {
  if (r.kind === 'title') return [{ text: r.text, color: theme.hunk, bold: true }];
  if (r.kind === 'context') return [{ text: `  ${r.text}`, color: theme.dim }];
  if (r.kind === 'gap') return [];
  const { name, color } = SIDES[r.side]();
  if (r.kind === 'label') return [{ text: ` ${name} `, bg: color, color: theme.ink, bold: true }, { text: r.text ? ` ${r.text}` : '', color: theme.dim }];
  if (r.kind === 'empty') return [{ text: '│ ', color }, { text: '(nothing)', color: theme.dim, italic: true }];
  return [{ text: '│ ', color }, { text: r.text, color }];
}

/** The conflict pane: a conflicted file's blocks, ours and theirs (and the base, in diff3 style). */
export function ConflictPane({ cf, f, width, height, focused, hint }) {
  const inner = width - 2;
  const message = (lines) => lines.map((text, i) => <Row key={i} pointer={false} width={inner} segments={[{ text: ` ${text}`, color: theme.dim }]} />);
  let body;
  if (!cf.file) body = message(['Loading…']);
  else if (cf.file.error) {
    body = message(
      cf.file.error.code === 'ENOENT'
        ? [`${f.path} isn't in the working tree: one side deleted it.`, 'O or T takes a side for the whole file.']
        : [cf.file.error.message.split('\n')[0]],
    );
  } else if (!cf.count) body = message([`No conflicts left in ${f.path}.`, 'space marks it resolved (in the file list).']);
  else {
    body = cf.rows.slice(cf.offset, cf.offset + height - 2).map((r, i) => {
      const on = r.block === cf.block;
      return (
        <Row
          key={cf.offset + i}
          width={inner}
          pointer={false}
          selected={focused && on && r.kind === 'title'}
          segments={[{ text: focused && on ? '▌' : ' ', color: theme.accent }, ...rowSegments(r)]}
        />
      );
    });
  }
  return (
    <Panel title={f.path} hint={hint} width={width} height={height} focused={focused}>
      {body}
    </Panel>
  );
}
