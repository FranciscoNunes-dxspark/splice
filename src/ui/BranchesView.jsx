import React, { useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { prsByBranch } from '../hosting.js';
import { defaultBranch, isDefaultBranch, relTime } from '../parse.js';
import { compareRefs, refLog } from '../repo.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { usePrList } from './prList.js';
import { Lines, Panel, Row } from './parts.jsx';
import { TONE, checksText } from './PrView.jsx';

function track(b) {
  if (b.gone) return 'gone';
  return [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
}

const commitLine = (c) => [
  { text: c.hash, color: theme.warn },
  { text: ` ${fit(relTime(c.time), 4, 'right')}`, color: theme.dim },
  { text: `  ${c.subject}` },
];

// The right-hand pane: the branch's PR, how it compares with the default branch and what it adds, then its history.
function paneLines(info, fresh, def, pr, vsDefault) {
  const lines = [];
  if (pr) {
    const checks = checksText(pr.checks);
    lines.push([
      { text: pr.label, color: TONE[pr.review.tone], bold: true },
      { text: ` ${pr.review.text}`, color: TONE[pr.review.tone] },
      ...(checks.text ? [{ text: `  ${checks.text}`, color: checks.color }] : []),
      { text: `  ${pr.draft ? 'draft · ' : ''}${pr.title}`, color: theme.dim },
    ]);
  }
  if (!info) return lines;
  // While another branch's numbers are still up, don't show them under this one's name.
  if (vsDefault && info.commits && fresh) {
    const { ahead, behind, commits } = info;
    lines.push(
      ahead || behind
        ? [
            { text: `↑${ahead} ahead`, color: ahead ? theme.add : theme.dim, bold: Boolean(ahead) },
            { text: ' · ', color: theme.dim },
            { text: `↓${behind} behind`, color: behind ? theme.warn : theme.dim, bold: Boolean(behind) },
            { text: ` ${def.ref}`, color: theme.local },
          ]
        : [{ text: 'Up to date with ', color: theme.dim }, { text: def.ref, color: theme.local }],
    );
    lines.push(...commits.map(commitLine));
    if (ahead > commits.length) lines.push([{ text: `… and ${ahead - commits.length} more`, color: theme.dim }]);
    if (commits.length && info.history.length) lines.push('', [{ text: 'Before that', color: theme.dim, bold: true }]);
  }
  lines.push(...info.history.map(commitLine));
  return lines;
}

export function BranchesView({ data, ctx, width, height, active, prVersion }) {
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
  const def = useMemo(() => defaultBranch(data.refs, data.remotes), [data.refs, data.remotes]);

  // The same list the PRs view shows, fetched once for both. No host or no sign-in: no PR column.
  const prs = usePrList(ctx, data, prVersion);
  const prOf = useMemo(
    () => (prs.host && prs.value ? prsByBranch(prs.value, data.refs, prs.host.remoteName) : new Map()),
    [prs.host, prs.value, data.refs],
  );

  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const logW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.ref), resetKey: data.root });
  const sel = rows[nav.index];
  const selPr = sel?.ref ? prOf.get(`${sel.type}:${sel.ref.name}`) : null;

  // A branch other than the default one is compared with it; the default branch and tags just show their history.
  const vsDefault = Boolean(sel?.ref && def && sel.type !== 'tag' && !isDefaultBranch(def, sel.ref, sel.type));
  const baseOid = def ? [...local, ...remote].find((b) => b.name === def.ref)?.oid : null;
  const infoKey = !sel?.ref || !split
    ? null
    : vsDefault
      ? `cmp:${data.root}:${sel.ref.name}:${sel.ref.oid}:${def.ref}:${baseOid}`
      : `brlog:${data.root}:${sel.ref.name}:${sel.ref.oid}`;
  const info = useAsync(infoKey, () =>
    vsDefault ? compareRefs(data.root, sel.ref.name, def.ref) : refLog(data.root, sel.ref.name).then((history) => ({ history })),
  );

  const nameW = Math.min(32, Math.max(8, ...rows.filter((r) => r.ref).map((r) => r.ref.name.length)));
  // The subject gives way first, then the PR column (before the name), and the upstream column before the PR one.
  const prW = prOf.size && innerW >= 2 + nameW + 9 + 12 + 5 + 6 ? 12 : 0;
  const upW = innerW >= 90 + prW ? Math.min(24, Math.max(0, ...local.map((b) => (b.upstream ?? '').length))) : 0;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'C') return a.cleanUp(ctx);
    if (input === 'M') return a.remote(ctx, '');
    if (!sel?.ref) return;
    const { name } = sel.ref;
    if (sel.type === 'tag' && input === 'u') return a.pushTag(ctx, name);
    if (sel.type === 'tag' && input === 'R') return a.createRelease(ctx, name);
    if (sel.type === 'local' && input === 'U') {
      const remote = data.remotes.includes('origin') ? 'origin' : data.remotes[0];
      return ctx.prefill(`/upstream ${name} ${sel.ref.upstream ?? (remote ? `${remote}/${name}` : '')}`);
    }
    if (key.return) a.checkout(ctx, name);
    else if (input === 'y') ctx.copy(name);
    else if (input === 'n') ctx.prefill(`/branch  ${name}`, 8);
    else if (input === 'm') a.merge(ctx, name, { ask: true });
    else if (input === 'e') a.rebase(ctx, name);
    else if (input === 'd') a.deleteRef(ctx, name);
    else if (input === 'D') a.compare(ctx, name);
    else if (input === 'o') {
      if (selPr) ctx.openUrl(selPr.url);
      else if (!prs.host) ctx.note("This repository's remote isn't on GitHub, Azure DevOps or GitLab.", 'error');
      else if (!prs.value) ctx.note(`Pull requests from ${prs.host.name} haven't loaded. Check the PRs view (6).`, 'error');
      else ctx.note(`${name} has no open pull request.`, 'error');
    }
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (split && e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the panel's top border. A double-click does what ↵ does.
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const hint = [vsDefault ? 'D diff' : '', selPr ? 'o open PR' : '', sel?.type === 'tag' ? 'u push · R release · d delete' : ''].filter(Boolean).join(' · ');
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
          if (prW) {
            const pr = prOf.get(`${type}:${ref.name}`);
            const checks = checksText(pr?.checks);
            segs.push(
              { text: ` ${fit(pr?.label ?? '', 6)}`, color: pr ? TONE[pr.review.tone] : undefined, italic: pr?.draft },
              { text: ` ${fit(pr ? checks.text : '', 4)}`, color: checks.color },
            );
          }
          if (upW) segs.push({ text: ` ${fit(type === 'local' ? ref.upstream ?? '' : '', upW)}`, color: theme.dim });
          segs.push({ text: ` ${fit(relTime(ref.date), 4, 'right')}`, color: theme.dim }, { text: `  ${ref.subject}` });
          return <Row key={`${type}:${ref.name}`} width={innerW} selected={idx === nav.index} focused={active} segments={segs} />;
        })}
      </Panel>
      {split ? (
        <Panel title={sel?.ref ? sel.ref.name : 'History'} hint={hint} width={logW} height={height}>
          <Lines width={logW - 2} height={innerH} lines={paneLines(info.value, info.key === infoKey, def, selPr, vsDefault)} />
        </Panel>
      ) : null}
    </Box>
  );
}
