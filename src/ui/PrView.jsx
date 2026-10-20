import React from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { renderMarkdown } from '../markdown.js';
import { relTime } from '../parse.js';
import { theme } from '../theme.js';
import { fit, fitSegments, wrap } from '../text.js';
import { useAsync, useListNav, usePrList } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const TONE = { good: theme.add, bad: theme.del, wait: theme.warn, none: theme.dim };
const VOTE = {
  approved: ['✓', theme.add],
  suggestions: ['✓', theme.add],
  rejected: ['✗', theme.del],
  waiting: ['…', theme.warn],
  commented: ['•', theme.hunk],
  none: ['○', theme.dim],
};
const CHECK = { pass: ['✓', theme.add], fail: ['✗', theme.del], pending: ['…', theme.warn] };

export function checksText(c) {
  if (!c) return { text: '' };
  if (c.failed) return { text: `✗ ${c.failed}`, color: theme.del };
  if (c.pending) return { text: `… ${c.pending}`, color: theme.warn };
  if (c.passed) return { text: '✓', color: theme.add };
  return { text: '' };
}

function detailLines(pr, d, width) {
  const lines = [];
  for (const l of wrap(pr.title, width)) lines.push([{ text: l, bold: true }]);
  lines.push([{ text: `${pr.label} by ${pr.author}`, color: theme.dim }, { text: `  ${relTime(pr.time)}`, color: theme.dim }]);
  lines.push([{ text: pr.source, color: theme.local }, { text: ' → ', color: theme.dim }, { text: pr.target, color: theme.local }]);
  const status = [{ text: pr.review.text, color: TONE[pr.review.tone], bold: true }];
  if (pr.draft) status.push({ text: '  draft', color: theme.dim });
  if (d?.conflicts || pr.conflicts) status.push({ text: '  merge conflicts', color: theme.del, bold: true });
  lines.push(status);

  const reviewers = d?.reviewers ?? pr.reviewers;
  if (reviewers.length) {
    lines.push('', [{ text: 'Reviewers', bold: true }]);
    for (const r of reviewers) {
      const [icon, color] = VOTE[r.vote] ?? VOTE.none;
      lines.push([{ text: ` ${icon} `, color, bold: true }, { text: r.name ?? '' }, { text: r.required ? '  required' : '', color: theme.dim }]);
    }
  }
  if (d?.checks?.length) {
    lines.push('', [{ text: 'Checks', bold: true }]);
    for (const c of d.checks) {
      const [icon, color] = CHECK[c.state];
      lines.push([{ text: ` ${icon} `, color, bold: true }, { text: c.name }]);
    }
  }
  if (pr.description.trim()) {
    lines.push('');
    lines.push(...renderMarkdown(pr.description, width).slice(0, 20));
  }
  if (!d) lines.push('', [{ text: 'Loading reviews, checks and comments…', color: theme.dim }]);
  else if (d.comments.length) {
    lines.push('', [{ text: `Comments (${d.comments.length})`, bold: true }]);
    for (const c of d.comments.slice(-15)) {
      lines.push([{ text: c.author ?? '', color: theme.hunk, bold: true }, { text: `  ${relTime(c.time)}`, color: theme.dim }]);
      for (const l of renderMarkdown(c.text, width - 2).slice(0, 6)) lines.push([{ text: '  ' }, ...l]);
    }
  }
  return lines;
}

export function PrView({ data, ctx, width, height, active, prVersion }) {
  const prs = usePrList(ctx, data, prVersion);
  const { host, key: listKey } = prs;
  const list = prs.value ?? [];

  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.55) : width;
  const detailW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(list.length, innerH, { resetKey: data.root });
  const pr = list[nav.index];
  ctx.selectedPr = pr ?? null;
  const detail = useAsync(pr && split ? `prd:${listKey}:${pr.id}` : null, () => host.detail(pr), 150);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'n') return a.createPr(ctx, '');
      if (input === 'W') return a.draftPr(ctx, '');
      if (!pr) return;
      if (key.return) ctx.showPrDiff(pr);
      else if (input === 'c') a.prCheckout(ctx, pr);
      else if (input === 'a') a.prApprove(ctx, pr);
      else if (input === 'C') ctx.prefill('/comment ');
      else if (input === 'o') ctx.openUrl(pr.url);
      else if (input === 'e' || input === 'R') a.claudeLook(ctx, input === 'e' ? 'explain' : 'review', { kind: 'pr', pr });
    },
    { isActive: active },
  );

  let message = null;
  if (!host) message = "This repository's remote isn't on GitHub or Azure DevOps.";
  else if (prs.error && !prs.value) message = `Couldn't load pull requests from ${host.name}: ${prs.error.message.split('\n')[0]}  (signed in? Run ${host.signIn} in a terminal.)`;
  else if (!prs.value) message = `Loading pull requests from ${host.name}…`;
  else if (!list.length) message = 'No open pull requests. Press n to open one from the current branch.';

  const meta = innerW >= 80;
  const hint = host ? `${host.name}${prs.loading && prs.value ? ' · refreshing' : ''}` : '';
  return (
    <Box width={width} height={height}>
      <Panel title="Pull requests" hint={hint} width={listW} height={height} focused={active}>
        {message ? <Row pointer={false} width={innerW} segments={[{ text: `  ${message}`, color: theme.dim }]} /> : null}
        {list.slice(nav.offset, nav.offset + innerH).map((p, i) => {
          const marker = p.reviewMe ? { text: '◆ ', color: theme.warn, bold: true } : p.mine ? { text: '● ', color: theme.accent } : { text: '  ' };
          const checks = checksText(p.checks);
          const segs = [
            marker,
            { text: `${fit(p.label, 6)} `, color: theme.dim },
            ...(p.draft ? [{ text: 'draft ', color: theme.dim, italic: true }] : []),
            { text: p.title, strong: true },
          ];
          // The title gives way to keep author, review state and checks lined up on the right.
          const right = meta
            ? [
                { text: ` ${fit(p.author, 14)}`, color: theme.dim },
                { text: ` ${fit(p.review.text, 18)}`, color: TONE[p.review.tone] },
                { text: ` ${fit(checks.text, 4)}`, color: checks.color },
              ]
            : [{ text: ` ${fit(p.review.text, 12)}`, color: TONE[p.review.tone] }];
          const rightW = meta ? 15 + 19 + 5 : 13;
          return (
            <Row
              key={p.id}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[...fitSegments(segs, innerW - 2 - rightW), ...right]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={pr ? pr.label : 'Details'} hint={pr ? 'o open in browser' : ''} width={detailW} height={height}>
          {pr ? <Lines lines={detailLines(pr, detail.value ?? null, detailW - 4)} width={detailW - 2} height={innerH} /> : null}
        </Panel>
      ) : null}
    </Box>
  );
}
