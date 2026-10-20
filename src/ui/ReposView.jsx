import React from 'react';
import { useInput } from 'ink';
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

export function ReposView({ repos, current, ctx, width, height, active, roots }) {
  const innerH = height - 3;
  const innerW = width - 2;
  const nav = useListNav(repos.length, innerH);
  const sel = repos[nav.index];
  const nameW = Math.min(36, Math.max(10, ...repos.map((r) => r.name.length)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 's') return ctx.prefill('/scan ');
    if (!sel) return;
    if (key.return) ctx.openRepo(sel.path);
    else if (input === 'x') ctx.forgetRepo(sel.path);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the border and the "Scanning" line.
    if (nav.pick(e.y - 2) && e.double) keys('', { return: true });
  });

  const scanning = roots.length ? `Scanning ${roots.join(', ')}` : 'Press s (or /scan <folder>) to add a folder of repositories.';
  return (
    <Panel title="Repositories" hint={`${repos.length}`} width={width} height={height} focused={active}>
      <Row pointer={false} width={innerW} segments={[{ text: scanning, color: theme.dim }]} />
      {repos.length === 0 ? (
        <Row pointer={false} width={innerW} segments={[{ text: '  No repositories yet. Use /open <path> or /scan <folder>.', color: theme.dim }]} />
      ) : null}
      {repos.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const isCurrent = current && samePath(current, r.path);
        const s = r.summary;
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
              { text: `  ${fit(summaryText(s).text, 10)}`, color: summaryText(s).color },
              { text: `  ${r.path}`, color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
