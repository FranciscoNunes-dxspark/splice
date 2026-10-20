import React from 'react';
import { Box, useInput } from 'ink';
import { basename, dirname } from 'node:path/posix';
import * as a from '../actions.js';
import { relTime } from '../parse.js';
import { stashFiles, stashStat } from '../repo.js';
import { codeColor, theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const WHAT = { M: 'modified', A: 'added', D: 'deleted', T: 'type changed', '?': 'untracked' };

function stashFileSegments(file) {
  const dir = dirname(file.path);
  return [
    { text: `${file.code} `, color: codeColor(file.code), bold: true },
    { text: dir === '.' ? '' : `${dir}/`, color: theme.dim },
    { text: basename(file.path), strong: true },
    { text: `  ${WHAT[file.code] ?? ''}`, color: theme.dim },
  ];
}

export function StashView({ data, ctx, width, height, active }) {
  const list = data.stashes;
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.5) : width;
  const statW = width - listW;
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { resetKey: data.root });
  const s = list[nav.index];
  const stat = useAsync(s && split ? `stash:${data.root}:${s.ref}:${s.time}:${s.message}` : null, () => stashStat(data.root, s.ref));

  // The stash's files, to restore one (↵) or see its diff (d).
  const showFiles = (st) =>
    ctx.showPicker({
      title: `Files in ${st.ref}  ${st.message}`,
      hint: '↵ restore · d diff',
      empty: 'This stash has no files.',
      load: async () => (await stashFiles(ctx.data.root, st.ref)).map((file) => ({ file, segments: stashFileSegments(file) })),
      onPick: (it) => a.restoreStashFile(ctx, st, it.file),
      keys: { d: (it) => ctx.showStashFile(st, it.file) },
    });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 's') return a.stash(ctx);
    if (input === 'S') return ctx.prefill('/stash ');
    if (!s) return;
    if (key.return) ctx.showStash(s);
    else if (input === 'y') ctx.copy(s.message, `the message of ${s.ref}`);
    else if (input === 'a') a.stashApply(ctx, s.ref);
    else if (input === 'o') a.stashApply(ctx, s.ref, { pop: true });
    else if (input === 'x') a.stashDrop(ctx, s);
    else if (input === 'F') showFiles(s);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (split && e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the panel's top border. A double-click does what ↵ does.
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  return (
    <Box width={width} height={height}>
      <Panel title="Stashes" hint={`${list.length}`} width={listW} height={height} focused={active}>
        {list.length === 0 ? (
          <Row pointer={false} width={listW - 2} segments={[{ text: '  No stashes. Press s to stash your changes (S to give the stash a message).', color: theme.dim }]} />
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
        <Panel title={s ? s.ref : 'Files'} hint={s ? '↵ full diff · f files' : ''} width={statW} height={height}>
          <Lines width={statW - 2} height={innerH} lines={(stat.value ?? '').split('\n').filter(Boolean)} />
        </Panel>
      ) : null}
    </Box>
  );
}
