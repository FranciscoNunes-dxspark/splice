import React, { useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { planProblem } from '../rebase.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav } from './hooks.js';
import { Panel, Row } from './parts.jsx';

const KEYS = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
const COLOR = { pick: theme.dim, reword: theme.local, edit: theme.remote, squash: theme.warn, fixup: theme.warn, drop: theme.del };

/**
 * The interactive rebase plan, newest commit on top like the graph. Rows are kept oldest first
 * (git's order) and drawn reversed, so "squash" folds a commit into the one drawn below it.
 */
export function RebaseEditor({ plan, ctx, width, height, active }) {
  const [rows, setRows] = useState(plan.rows);
  const innerH = height - 3;
  const shown = [...rows].reverse();
  const nav = useListNav(shown.length, innerH);
  const at = rows.length - 1 - nav.index; // index into rows (oldest first)

  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (dir) => {
    // dir +1 moves the commit up the screen, i.e. later in git's order.
    const j = at + dir;
    if (j < 0 || j >= rows.length) return;
    setRows((rs) => {
      const next = [...rs];
      [next[at], next[j]] = [next[j], next[at]];
      return next;
    });
    nav.setIndex(nav.index - dir);
  };
  // /reword <message> lands here.
  ctx.rebaseEditor = { reword: (text) => update(at, { action: 'reword', newMessage: text }) };

  useInput(
    (input, key) => {
      if (!ctx.overlayHasKeys()) return;
      if (key.escape || input === 'q') return ctx.closeOverlay();
      if (input === 'K' || (key.shift && key.upArrow)) return move(1);
      if (input === 'J' || (key.shift && key.downArrow)) return move(-1);
      if (nav.handle(input, key)) return;
      if (key.return) return a.runRebase(ctx, plan.base, rows);
      const action = KEYS[input];
      if (!action) return;
      if (action === 'reword') return ctx.prefill(`/reword ${rows[at].newMessage ?? rows[at].subject}`);
      update(at, { action });
    },
    { isActive: active },
  );

  const problem = planProblem(rows);
  const changed = rows.some((r, i) => r.action !== 'pick' || r.hash !== plan.rows[i].hash);
  return (
    <Panel title={`Interactive rebase from ${plan.from}`} hint={`${rows.length} commits · ↵ start · esc cancel`} width={width} height={height} focused={active}>
      <Row
        pointer={false}
        width={width - 2}
        segments={
          problem
            ? [{ text: `  ${problem}`, color: theme.del }]
            : [{ text: `  p pick · r reword · e edit · s squash · f fixup (into the one below) · d drop · J/K move${changed ? '' : '   (nothing changed yet)'}`, color: theme.dim }]
        }
      />
      {shown.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const selected = nav.offset + i === nav.index;
        const dropped = r.action === 'drop';
        return (
          <Row
            key={r.hash}
            width={width - 2}
            selected={selected}
            focused={active}
            segments={[
              { text: fit(r.action, 7), color: COLOR[r.action], bold: r.action !== 'pick' },
              { text: ` ${r.hash.slice(0, 7)} `, color: theme.warn },
              { text: r.action === 'reword' ? r.newMessage.split('\n')[0] : r.subject, color: dropped ? theme.dim : undefined, strong: !dropped },
              { text: r.action === 'reword' ? `  (was: ${r.subject})` : '', color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
