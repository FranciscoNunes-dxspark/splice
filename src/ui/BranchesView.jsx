import React, { useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { refLog } from '../repo.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

function track(b) {
  if (b.gone) return 'gone';
  return [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
}

export function BranchesView({ data, ctx, width, height, active }) {
  const { local, remote, tags } = data.refs;
  const rows = useMemo(() => {
    const out = [];
    const section = (title, list, type) => {
      out.push({ header: title, count: list.length });
      for (const ref of list) out.push({ ref, type });
    };
    section('Local', local, 'local');
    section('Remote', remote, 'remote');
    if (tags.length) section('Tags', tags, 'tag');
    return out;
  }, [data.refs]);

  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const logW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.ref), resetKey: data.root });
  const sel = rows[nav.index];
  const log = useAsync(sel?.ref && split ? `log:${data.root}:${sel.ref.name}:${sel.ref.oid}` : null, () => refLog(data.root, sel.ref.name));

  const nameW = Math.min(32, Math.max(8, ...rows.filter((r) => r.ref).map((r) => r.ref.name.length)));
  const upW = innerW >= 90 ? Math.min(24, Math.max(0, ...local.map((b) => (b.upstream ?? '').length))) : 0;

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key) || !sel?.ref) return;
      const { name } = sel.ref;
      if (key.return) a.checkout(ctx, name);
      else if (input === 'n') ctx.prefill(`/branch  ${name}`, 8);
      else if (input === 'm') a.merge(ctx, name, { ask: true });
      else if (input === 'e') a.rebase(ctx, name);
      else if (input === 'd') a.deleteRef(ctx, name);
    },
    { isActive: active },
  );

  return (
    <Box width={width} height={height}>
      <Panel title="Branches" hint={`${local.length} local · ${remote.length} remote`} width={listW} height={height} focused={active}>
        {rows.slice(nav.offset, nav.offset + innerH).map((row, i) => {
          const idx = nav.offset + i;
          if (row.header) {
            return (
              <Row key={`h${row.header}`} width={innerW} pointer={false} segments={[{ text: row.header, bold: true }, { text: ` (${row.count})`, color: theme.dim }]} />
            );
          }
          const { ref, type } = row;
          const color = ref.current ? theme.accent : type === 'local' ? theme.local : type === 'remote' ? theme.remote : theme.tag;
          const segs = [
            { text: ref.current ? '● ' : '  ', color: theme.accent, bold: true },
            { text: fit(ref.name, nameW), color, bold: ref.current, strong: true },
            { text: ` ${fit(type === 'local' ? track(ref) : '', 8)}`, color: ref.gone ? theme.del : theme.warn },
          ];
          if (upW) segs.push({ text: ` ${fit(type === 'local' ? ref.upstream ?? '' : '', upW)}`, color: theme.dim });
          segs.push({ text: ` ${fit(relTime(ref.date), 4, 'right')}`, color: theme.dim }, { text: `  ${ref.subject}` });
          return <Row key={`${type}:${ref.name}`} width={innerW} selected={idx === nav.index} focused={active} segments={segs} />;
        })}
      </Panel>
      {split ? (
        <Panel title={sel?.ref ? sel.ref.name : 'History'} width={logW} height={height}>
          <Lines
            width={logW - 2}
            height={innerH}
            lines={(log.value ?? []).map((c) => [
              { text: c.hash, color: theme.warn },
              { text: ` ${fit(relTime(c.time), 4, 'right')}`, color: theme.dim },
              { text: `  ${c.subject}` },
            ])}
          />
        </Panel>
      ) : null}
    </Box>
  );
}
