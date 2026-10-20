import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { useListNav } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/**
 * A list to pick from, as an overlay (ctx.showPicker): reflog entries, a file's history, a commit to fix up.
 * `items` are { segments, ...anything else the caller needs }, or `load` fetches them first.
 * ↵ runs `onPick(item)`; `keys` maps other keys to `(item) => ...`. Esc closes it, and an overlay
 * opened from here (a diff, say) comes back to it, cursor and all, when that one closes.
 */
export function Picker({ picker, ctx, width, height, active }) {
  const { title, hint = '', empty = 'Nothing here.', onPick, keys = {} } = picker;
  const [state, setState] = useState(() => (picker.items ? { items: picker.items } : { loading: true }));
  useEffect(() => {
    if (picker.items) return;
    let live = true;
    picker.load().then(
      (items) => {
        // Kept on the overlay, so coming back to it doesn't load again.
        picker.items = items;
        if (live) setState({ items });
      },
      (e) => live && setState({ error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [picker]);

  const items = state.items ?? [];
  const innerH = height - 2;
  const nav = useListNav(items.length, innerH);
  // Read before the first render below writes over it.
  const [returnTo] = useState(picker.index);
  useEffect(() => {
    if (returnTo) nav.setIndex(returnTo);
  }, [picker]);
  picker.index = nav.index;
  const item = items[nav.index];

  useInput(
    (input, key) => {
      if (!ctx.overlayHasKeys()) return;
      if (key.escape || input === 'q') return ctx.closeOverlay();
      if (nav.handle(input, key)) return;
      if (!item) return;
      if (key.return) return onPick?.(item);
      keys[input]?.(item);
    },
    { isActive: active },
  );

  const status = state.loading ? 'Loading…' : state.error ? state.error : items.length ? null : empty;
  const pos = items.length > innerH ? `${nav.index + 1}/${items.length} · ` : '';
  return (
    <Panel title={title} hint={`${pos}${hint}${hint ? ' · ' : ''}esc close`} width={width} height={height} focused={active}>
      {status ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${status}`, color: state.error ? theme.del : theme.dim }]} /> : null}
      {items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
        <Row key={nav.offset + i} width={width - 2} selected={nav.offset + i === nav.index} focused={active} segments={it.segments} />
      ))}
    </Panel>
  );
}
