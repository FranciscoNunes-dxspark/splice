import { theme } from './theme.js';

// The commit graph, laid out the way git-graph does it rather than read from `git log --graph`. Every
// commit belongs to one branch, traced from the branch's tip down its first parents, the default
// branch first. Each branch gets a column of its own, the default branch the left-most, and branches
// that never overlap share one. A merge's line leaves from the merge's own row, with git-graph's arrow
// pointing into the merge. To give the graph room, a row with no commit follows each merge, and a
// branch bends into the commit it started from on a row of its own, just above that commit.

// Groups of branches, left to right: the default branch, then releases and hotfixes, then develop,
// then everything else, merged branches with no name left included.
const GROUPS = [/^(main|master|trunk)$/, /^(release|hotfix)\b/, /^(develop|dev)$/];

// Box-drawing pieces by the sides they reach.
const U = 8;
const D = 4;
const L = 2;
const R = 1;
const PIECES = {
  [U | D]: '│', [L | R]: '─', [D | L]: '╮', [D | R]: '╭', [U | L]: '╯', [U | R]: '╰',
  [U | D | L]: '┤', [U | D | R]: '├', [D | L | R]: '┬', [U | L | R]: '┴', [U | D | L | R]: '┼',
  [U]: '│', [D]: '│', [L]: '─', [R]: '─',
};

/**
 * Lays out the graph for `rows` (one commit each, children before their parents, as `git log
 * --date-order` lists them). Returns `rows`: those rows, each with a `graph` (one `{ ch, color, node }`
 * per column), with the graph's connector rows (just a `graph`) between them. `main` names the default
 * branch. With `wip` (HEAD's hash, when the working tree has changes) it also returns the cells of a row
 * for those changes, drawn above everything in HEAD's column, with a line down to HEAD when the way is clear.
 */
export function layoutGraph(rows, { wip, main } = {}) {
  const index = new Map(rows.map((r, i) => [r.commit.hash, i]));
  const groupOf = (name) => {
    if (name === main) return 0;
    const g = GROUPS.findIndex((re) => re.test(name));
    return g < 0 ? GROUPS.length : g;
  };

  // Which branch each row's commit belongs to: the tips with a name first, by group, local before
  // remote, newest first; then whatever is left, from the top (branches merged and since deleted).
  const owner = new Array(rows.length);
  const tracks = [];
  const trace = (start, group) => {
    if (owner[start] !== undefined) return;
    const t = { group };
    tracks.push(t);
    for (let i = start; i !== undefined && owner[i] === undefined; i = index.get(rows[i].commit.parents[0])) owner[i] = t;
  };
  const tips = [];
  rows.forEach((r, i) => {
    for (const ref of r.commit.refs ?? []) {
      if (ref.type === 'local') tips.push({ i, group: groupOf(ref.name), remote: 0 });
      if (ref.type === 'remote') tips.push({ i, group: groupOf(ref.name.slice(ref.name.indexOf('/') + 1)), remote: 1 });
    }
  });
  tips.sort((a, b) => a.group - b.group || a.remote - b.remote || a.i - b.i);
  for (const t of tips) trace(t.i, t.group);
  rows.forEach((_, i) => trace(i, GROUPS.length));

  // Where each commit goes, counting the connector rows: one after a merge, and one above a commit that
  // a branch bends into. One row does for both.
  const bentInto = new Set();
  rows.forEach((r, i) => {
    const j = index.get(r.commit.parents[0]);
    if (j !== undefined && owner[j] !== owner[i]) bentInto.add(j);
  });
  const at = [];
  let height = 0;
  rows.forEach((r, i) => {
    if (i > 0 && (rows[i - 1].commit.parents.length > 1 || bentInto.has(i))) height++;
    at[i] = height++;
  });

  // The rows each branch's line takes up: from its tip, or the merge that brought it in if that's
  // higher, down to the row where it bends into the commit it started from (the bottom, when that
  // commit isn't loaded).
  rows.forEach((_, i) => {
    owner[i].top = Math.min(owner[i].top ?? at[i], at[i]);
    owner[i].bottom = Math.max(owner[i].bottom ?? at[i], at[i]);
  });
  rows.forEach((r, i) => {
    r.commit.parents.forEach((p, k) => {
      const j = index.get(p);
      if (j === undefined) {
        if (k === 0) owner[i].bottom = height - 1;
      } else if (owner[j] !== owner[i]) {
        if (k === 0) owner[i].bottom = Math.max(owner[i].bottom, at[j] - 1);
        else owner[j].top = Math.min(owner[j].top, at[i]);
      }
    });
  });

  // Columns, group by group: branches in the order they start, each in the left-most column it doesn't
  // overlap, which takes as few columns as there can be.
  let offset = 0;
  for (let g = 0; g <= GROUPS.length; g++) {
    const columns = [];
    const group = tracks.filter((t) => t.group === g).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    for (const t of group) {
      let c = columns.findIndex((used) => used.every((o) => t.top > o.bottom || t.bottom < o.top));
      if (c < 0) c = columns.push([]) - 1;
      columns[c].push(t);
      t.column = offset + c;
    }
    offset += columns.length;
  }

  // Colours: the default branch's own; the others in turn, unlike the branches beside them.
  const others = theme.lanes.slice(1);
  let turn = 0;
  for (const t of [...tracks].sort((a, b) => a.top - b.top)) {
    if (t.group === 0) {
      t.color = theme.lanes[0];
      continue;
    }
    const near = tracks.filter((o) => o.color && Math.abs(o.column - t.column) === 1 && o.top <= t.bottom && o.bottom >= t.top).map((o) => o.color);
    let k = 0;
    while (k < others.length - 1 && near.includes(others[(turn + k) % others.length])) k++;
    t.color = others[(turn + k) % others.length];
    turn += k + 1;
  }
  // Where lines meet, the more lasting branch's colour shows.
  tracks.forEach((t, i) => (t.rank = t.group * tracks.length + i));

  // A cell keeps the colour of what runs down it and of what runs across it apart: a line down that
  // goes on through it shows its own, otherwise the line across does, so a merge's line is one colour
  // all the way to its arrow.
  const grid = Array.from({ length: height }, () => []);
  const mark = (y, x, sides, t) => {
    const cell = (grid[y][x] ??= { sides: 0 });
    if (cell.node) return;
    cell.sides |= sides;
    const way = sides & (U | D) ? 'v' : 'h';
    if (cell[way] === undefined || t.rank < cell[way].rank) cell[way] = t;
  };
  const colorOf = (cell) => ((cell.sides & (U | D)) === (U | D) || !cell.h ? cell.v : cell.h).color;
  const down = (col, from, to, t) => {
    for (let y = from; y <= to; y++) mark(y, 2 * col, U | D, t);
  };
  const across = (y, a, b, t) => {
    const [lo, hi] = a < b ? [2 * a, 2 * b] : [2 * b, 2 * a];
    for (let x = lo; x <= hi; x++) mark(y, x, (x > lo ? L : 0) | (x < hi ? R : 0), t);
  };
  rows.forEach((r, i) => {
    const t = owner[i];
    const y = at[i];
    grid[y][2 * t.column] = { node: r.commit.parents.length > 1 ? '○' : '●', color: t.color };
    r.commit.parents.forEach((p, k) => {
      const j = index.get(p);
      if (j === undefined) {
        if (k === 0) down(t.column, y + 1, height - 1, t);
        return;
      }
      const to = owner[j];
      if (to.column === t.column) down(t.column, y + 1, at[j] - 1, t);
      else if (k === 0) {
        // The branch ends: down its own column, then across into the commit it started from, on the row above it.
        const bend = at[j] - 1;
        down(t.column, y + 1, bend - 1, t);
        mark(bend, 2 * t.column, U, t);
        across(bend, t.column, to.column, t);
        mark(bend, 2 * to.column, D, to);
      } else {
        // A merge: across to the merged branch's column, then down it, with an arrow into the merge.
        across(y, t.column, to.column, to);
        mark(y, 2 * to.column, D, to);
        down(to.column, y + 1, at[j] - 1, to);
        const arrow = grid[y][to.column > t.column ? 2 * t.column + 1 : 2 * t.column - 1];
        Object.assign(arrow, { arrow: to.column > t.column ? '<' : '>', h: { color: to.color, rank: -1 } });
      }
    });
  });

  // A line from the working-tree row down to HEAD, when nothing comes down that column above it.
  const k = wip ? index.get(wip) : undefined;
  const head = k === undefined ? null : owner[k];
  if (head && grid.slice(0, at[k]).every((cells) => !cells[2 * head.column]?.node && !(cells[2 * head.column]?.sides & U))) {
    down(head.column, 0, at[k] - 1, head);
  }

  const out = grid.map((cells) => {
    const graph = Array.from(cells, (cell) =>
      !cell ? { ch: ' ' } : cell.node ? { ch: cell.node, color: cell.color, node: true } : { ch: cell.arrow ?? PIECES[cell.sides] ?? ' ', color: colorOf(cell) },
    );
    while (graph.length && graph.at(-1).ch === ' ') graph.pop();
    return { graph };
  });
  rows.forEach((r, i) => (out[at[i]] = { ...r, graph: out[at[i]].graph }));
  if (!head) return { rows: out, wip: null };
  return { rows: out, wip: [...Array.from({ length: 2 * head.column }, () => ({ ch: ' ' })), { ch: '◌', color: theme.accent, node: true }] };
}
