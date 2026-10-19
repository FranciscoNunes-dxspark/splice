import React from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { stashStat } from '../repo.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export function StashView({ data, ctx, width, height, active }) {
  const list = data.stashes;
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.5) : width;
  const statW = width - listW;
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { resetKey: data.root });
  const s = list[nav.index];
  const stat = useAsync(s && split ? `stash:${data.root}:${s.ref}:${s.time}:${s.message}` : null, () => stashStat(data.root, s.ref));

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 's') return ctx.prefill('/stash ');
      if (!s) return;
      if (key.return) ctx.showStash(s);
      else if (input === 'a') a.stashApply(ctx, s.ref);
      else if (input === 'o') a.stashApply(ctx, s.ref, { pop: true });
      else if (input === 'x') a.stashDrop(ctx, s);
    },
    { isActive: active },
  );

  return (
    <Box width={width} height={height}>
      <Panel title="Stashes" hint={`${list.length}`} width={listW} height={height} focused={active}>
        {list.length === 0 ? (
          <Row pointer={false} width={listW - 2} segments={[{ text: '  No stashes. Press s to stash your changes.', color: theme.dim }]} />
        ) : null}
        {list.slice(nav.offset, nav.offset + innerH).map((st, i) => (
          <Row
            key={st.ref}
            width={listW - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(st.ref, 11), color: theme.warn },
              { text: ` ${fit(relTime(st.time), 4, 'right')}`, color: theme.dim },
              { text: `  ${st.message}`, strong: true },
            ]}
          />
        ))}
      </Panel>
      {split ? (
        <Panel title={s ? s.ref : 'Files'} hint={s ? '↵ full diff' : ''} width={statW} height={height}>
          <Lines width={statW - 2} height={innerH} lines={(stat.value ?? '').split('\n').filter(Boolean)} />
        </Panel>
      ) : null}
    </Box>
  );
}
