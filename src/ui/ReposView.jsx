import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { samePath } from '../config.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

export function summaryText(s) {
  if (!s) return { text: '…', color: theme.dim };
  if (s.error) return { text: 'unavailable', color: theme.del };
  const parts = [];
  if (s.ahead) parts.push(`↑${s.ahead}`);
  if (s.behind) parts.push(`↓${s.behind}`);
  if (s.changes) parts.push(`● ${s.changes}`);
  return { text: parts.join(' ') || '✓', color: s.changes ? theme.warn : theme.dim };
}

/** A row's summary column: while F fetches it, says so. */
export function rowStatus(r) {
  if (r.fetch?.state === 'fetching') return { text: 'fetching…', color: theme.dim };
  return summaryText(r.summary);
}

// `progress`: { done, total } while F fetches them all.
export function ReposView({ repos, current, ctx, width, height, active, roots, progress }) {
  const innerH = height - 3;
  const innerW = width - 2;
  const nav = useListNav(repos.length, innerH);
  const sel = repos[nav.index];
  const nameW = Math.min(36, Math.max(10, ...repos.map((r) => r.name.length)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 's') return ctx.prefill('/scan ');
    if (input === 'c') return ctx.prefill('/clone ');
    if (input === 'F') return a.fetchRepos(ctx);
    if (!sel) return;
    if (key.return) ctx.openRepo(sel.path);
    else if (input === 'x') ctx.forgetRepo(sel.path);
    else if (input === 'y') ctx.copy(sel.path);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the border and the "Scanning" line.
    if (nav.pick(e.y - 2) && e.double) keys('', { return: true });
  });

  const scanning = roots.length ? `Scanning ${roots.join(', ')}` : 'Press s (or /scan <folder>) to add a folder of repositories.';
  return (
    <Panel title="Repositories" hint={progress ? `fetched ${progress.done} of ${progress.total}` : `${repos.length}`} width={width} height={height} focused={active}>
      <Row pointer={false} width={innerW} segments={[{ text: scanning, color: theme.dim }]} />
      {repos.length === 0 ? (
        <Row pointer={false} width={innerW} segments={[{ text: '  No repositories yet. Use /open <path> or /scan <folder>.', color: theme.dim }]} />
      ) : null}
      {repos.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const isCurrent = current && samePath(current, r.path);
        const s = r.summary;
        const status = rowStatus(r);
        return (
          <Row
            key={r.path}
            width={innerW}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: isCurrent ? '● ' : '  ', color: theme.accent, bold: true },
              { text: fit(r.name, nameW), bold: true, color: isCurrent ? theme.accent : undefined },
              { text: `  ${fit(s?.branch ?? (s && !s.error ? 'detached' : ''), 20)}`, color: theme.local },
              { text: `  ${fit(status.text, 10)}`, color: status.color },
              // A fetch that failed says why, ahead of the path.
              ...(r.fetch?.state === 'failed' ? [{ text: `  ✗ ${r.fetch.error}`, color: theme.del }] : []),
              { text: `  ${r.path}`, color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
