import React, { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { worktreeDetail } from '../repo.js';
import { eachLimited, summarize } from '../repos.js';
import { codeColor, theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { summaryText } from './ReposView.jsx';

function branchLabel(w) {
  if (w.bare) return { text: 'bare', color: theme.dim };
  if (w.branch) return { text: w.branch, color: theme.local };
  return { text: `detached ${(w.head ?? '').slice(0, 7)}`, color: theme.warn };
}

function flags(w) {
  if (w.prunable) return { text: 'missing', color: theme.del };
  if (w.locked) return { text: 'locked', color: theme.warn };
  if (w.main) return { text: 'main', color: theme.dim };
  return { text: '', color: theme.dim };
}

export function WorktreesView({ data, ctx, width, height, active }) {
  const list = data.worktrees;
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(list.length, innerH, { resetKey: data.root });
  const wt = list[nav.index];
  const usable = (w) => w && !w.prunable && !w.bare;
  const detail = useAsync(usable(wt) && split ? `worktree:${wt.path}:${data.loadedAt}` : null, () => worktreeDetail(wt.path));

  // Each worktree's own branch state and changes, read again whenever the open repo reloads.
  const [summaries, setSummaries] = useState({});
  useEffect(() => {
    let live = true;
    eachLimited(list.filter(usable), 4, (w) => summarize(w.path), (w, s) => live && setSummaries((m) => ({ ...m, [w.path]: s })));
    return () => {
      live = false;
    };
  }, [data.loadedAt]);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'n') return ctx.prefill(`/worktree ../${data.name}-`);
      if (!wt) return;
      if (key.return) {
        if (wt.prunable) return ctx.note('Its folder is gone. Press x to prune it.', 'error');
        ctx.openRepo(wt.path).then((ok) => ok && ctx.setView('graph'));
      } else if (input === 'x') a.removeWorktree(ctx, wt);
    },
    { isActive: active },
  );

  const nameW = Math.min(28, Math.max(8, ...list.map((w) => basename(w.path).length)));
  const branchW = Math.min(28, Math.max(8, ...list.map((w) => branchLabel(w).text.length)));
  const sideLines = [];
  if (wt?.prunable) sideLines.push([{ text: wt.reason || 'The folder no longer exists.', color: theme.del }]);
  if (wt?.locked && wt.reason) sideLines.push([{ text: `Locked: ${wt.reason}`, color: theme.warn }]);
  if (detail.value) {
    for (const line of detail.value.status) {
      sideLines.push(line.startsWith('##') ? [{ text: line.slice(3), color: theme.local, bold: true }] : [{ text: line.slice(0, 2), color: codeColor(line.trim()[0]) }, { text: line.slice(2) }]);
    }
    sideLines.push('');
    for (const c of detail.value.commits) {
      sideLines.push([{ text: c.hash, color: theme.warn }, { text: ` ${fit(relTime(c.time), 4, 'right')}`, color: theme.dim }, { text: `  ${c.subject}` }]);
    }
  }

  return (
    <Box width={width} height={height}>
      <Panel title="Worktrees" hint={`${list.length}`} width={listW} height={height} focused={active}>
        {list.slice(nav.offset, nav.offset + innerH).map((w, i) => {
          const s = summaryText(summaries[w.path]);
          const b = branchLabel(w);
          const f = flags(w);
          return (
            <Row
              key={w.path}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: w.current ? '● ' : '  ', color: theme.accent, bold: true },
                { text: fit(basename(w.path), nameW), bold: true, color: w.current ? theme.accent : undefined, strong: true },
                { text: `  ${fit(b.text, branchW)}`, color: b.color },
                { text: `  ${fit(usable(w) ? s.text : '', 10)}`, color: s.color },
                { text: `  ${fit(f.text, 7)}`, color: f.color },
                { text: `  ${w.path}`, color: theme.dim },
              ]}
            />
          );
        })}
        {list.length < 2 ? (
          <Row pointer={false} width={innerW} segments={[{ text: '  No other worktrees. Press n (or /worktree <path> [ref]) to add one.', color: theme.dim }]} />
        ) : null}
      </Panel>
      {split ? (
        <Panel title={wt ? basename(wt.path) : 'Worktree'} hint={wt && !wt.current && !wt.prunable ? '↵ open' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={sideLines} />
        </Panel>
      ) : null}
    </Box>
  );
}
