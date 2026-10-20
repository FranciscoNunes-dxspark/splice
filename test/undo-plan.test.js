import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeUndo, parseReflog, planUndo, reflogActionFor, reflogLabel } from '../src/undo.js';

const H = (c) => c.repeat(40);
// One `git log -g --date=unix --format=REFLOG_FORMAT` line.
const line = (hash, time, gs, subject = '') => [hash, `HEAD@{${time}}`, gs, subject].join('\x1f');
const log = (...lines) => parseReflog(lines.join('\n') + '\n');

test('parseReflog splits hash, time, action, message and subject', () => {
  const [e] = log(line(H('a'), 1760000000, 'commit: fix: a colon in the message', 'fix: a colon in the message'));
  assert.equal(e.hash, H('a'));
  assert.equal(e.time, 1760000000);
  assert.equal(e.action, 'commit');
  assert.equal(e.message, 'fix: a colon in the message');
  assert.equal(e.kind, 'commit');
  assert.deepEqual(parseReflog(''), []);
});

test('classify names the kind of change, its phase and the merged ref', () => {
  assert.deepEqual(classify('commit (amend)'), { kind: 'amend', phase: null, ref: null });
  assert.equal(classify('commit (initial)').kind, 'initial');
  assert.equal(classify('commit (merge)').kind, 'merge');
  assert.deepEqual(classify('merge feature'), { kind: 'merge', phase: null, ref: 'feature' });
  assert.deepEqual(classify('rebase (pick)'), { kind: 'rebase', phase: 'pick', ref: null });
  assert.deepEqual(classify('rebase -i (finish)'), { kind: 'rebase', phase: 'finish', ref: null });
  assert.equal(classify('pull --rebase (finish)').kind, 'pull');
  assert.equal(classify('checkout').kind, 'checkout');
  assert.equal(classify('cherry-pick').kind, 'cherry-pick');
  assert.equal(reflogLabel(classify('rebase (start)')), 'rebase start');
  assert.equal(reflogLabel(classify('rebase (finish)')), 'rebase');
  assert.equal(reflogLabel(classify('commit (initial)')), 'commit');
});

test('a commit is undone softly, to the position before it on the branch', () => {
  const head = log(line(H('b'), 200, 'commit: Fix typo', 'Fix typo'), line(H('a'), 100, 'commit (initial): Start', 'Start'));
  const plan = planUndo({ head, branch: head, branchName: 'main', oid: H('b') });
  assert.equal(plan.kind, 'reset');
  assert.equal(plan.mode, 'soft');
  assert.equal(plan.target, H('a'));
  const text = describeUndo(plan);
  assert.equal(text.title, 'Undo the commit "Fix typo"?');
  assert.match(text.detail, /Its changes go back to staged; main goes back to aaaaaaa "Start"\./);
  assert.equal(text.yes, 'Yes, undo');
});

test("a rebase is one step on the branch's own reflog, and moves back with --keep", () => {
  const head = log(
    line(H('d'), 300, 'rebase (finish): returning to refs/heads/feat', 'two'),
    line(H('d'), 300, 'rebase (pick): two', 'two'),
    line(H('c'), 300, 'rebase (start): checkout main', 'three'),
    line(H('b'), 200, 'commit: two', 'two'),
  );
  const branch = log(line(H('d'), 300, 'rebase (finish): refs/heads/feat onto cccc', 'two'), line(H('b'), 200, 'commit: two', 'two'));
  const plan = planUndo({ head, branch, branchName: 'feat', oid: H('d') });
  assert.equal(plan.mode, 'keep');
  assert.equal(plan.target, H('b'));
  assert.equal(describeUndo(plan).title, 'Undo the rebase of feat?');
  // Detached, HEAD's own reflog is stepped back past the whole rebase.
  const detached = planUndo({ head, oid: H('d') });
  assert.equal(detached.target, H('b'));
  assert.match(describeUndo(detached).detail, /^HEAD goes back to bbbbbbb "two"/);
});

test('a switch is undone by switching back to where it came from', () => {
  const head = log(line(H('b'), 200, 'checkout: moving from main to feat', 'x'), line(H('a'), 100, 'commit: x', 'x'));
  const plan = planUndo({ head, branch: [], branchName: 'feat', oid: H('b') });
  assert.deepEqual([plan.kind, plan.from, plan.to], ['switch', 'main', 'feat']);
  assert.equal(describeUndo(plan).title, 'Switch back to main?');
  const fromDetached = planUndo({ head: log(line(H('b'), 200, `checkout: moving from ${H('c')} to feat`)), oid: H('b') });
  assert.equal(describeUndo(fromDetached).title, 'Switch back to ccccccc?');
});

test('a merge, the amend, the first commit and an undo itself', () => {
  const merge = log(line(H('b'), 200, 'merge feature: Fast-forward', 'F'), line(H('a'), 100, 'commit: A', 'A'));
  assert.equal(describeUndo(planUndo({ head: merge, branch: merge, branchName: 'main', oid: H('b') })).title, 'Undo the merge of feature into main?');

  const amend = log(line(H('b'), 200, 'commit (amend): Better', 'Better'), line(H('a'), 100, 'commit: Worse', 'Worse'));
  const ap = planUndo({ head: amend, branch: amend, branchName: 'main', oid: H('b') });
  assert.equal(ap.mode, 'soft');
  assert.equal(describeUndo(ap).title, 'Undo the amend of "Better"?');

  const first = log(line(H('a'), 100, 'commit (initial): Start', 'Start'));
  const fp = planUndo({ head: first, branch: first, branchName: 'main', oid: H('a') });
  assert.equal(fp.kind, 'unborn');
  assert.equal(describeUndo(fp).title, 'Undo the first commit "Start"?');

  // A second z after undoing a commit offers to redo it, and the one after that to undo again.
  const undone = log(line(H('a'), 300, 'undo: updating HEAD', 'A'), line(H('b'), 200, 'commit: B', 'B'));
  const up = planUndo({ head: undone, branch: undone, branchName: 'main', oid: H('a') });
  assert.deepEqual([up.mode, up.target], ['keep', H('b')]);
  assert.equal(describeUndo(up).title, 'Redo what was just undone?');
  assert.equal(describeUndo(up).yes, 'Yes, redo');
  assert.equal(reflogActionFor(up), 'redo');
  const redone = log(line(H('b'), 400, 'redo: updating HEAD', 'B'), line(H('a'), 300, 'undo: updating HEAD', 'A'));
  const rp = planUndo({ head: redone, branch: redone, branchName: 'main', oid: H('b') });
  assert.equal(describeUndo(rp).title, 'Undo that again?');
  assert.equal(reflogActionFor(rp), 'undo');
});

test('pushed changes are called out in the confirmation', () => {
  const head = log(line(H('b'), 200, 'commit: B', 'B'), line(H('a'), 100, 'commit: A', 'A'));
  const text = describeUndo(planUndo({ head, branch: head, branchName: 'main', oid: H('b') }), { pushed: 'origin/main' });
  assert.match(text.detail, /^It's already on origin\/main: this only undoes it here/);
});

test('nothing to undo, and a reflog that disagrees with where the branch is', () => {
  assert.equal(planUndo({ head: [], oid: H('a') }).kind, 'none');
  assert.equal(planUndo({ head: [], oid: null }).kind, 'none');
  const head = log(line(H('b'), 200, 'commit: B', 'B'), line(H('a'), 100, 'commit: A', 'A'));
  assert.equal(planUndo({ head, branch: head, branchName: 'main', oid: H('c') }).kind, 'none');
});

test('a discard newer than the last reflog change is what gets undone', () => {
  const head = log(line(H('b'), 200, 'commit: B', 'B'), line(H('a'), 100, 'commit: A', 'A'));
  const base = { head, branch: head, branchName: 'main', oid: H('b') };
  const discard = { id: 'x', at: 250_000, what: 'the changes to a.txt' };
  const plan = planUndo({ ...base, discard });
  assert.equal(plan.kind, 'discard');
  const text = describeUndo(plan, { now: 250 + 120 });
  assert.equal(text.title, 'Bring back the changes to a.txt?');
  assert.equal(text.detail, 'Undoes the discard from 2m ago.');
  // An older discard waits behind the newer commit.
  assert.equal(planUndo({ ...base, discard: { ...discard, at: 150_000 } }).kind, 'reset');
  // And is still offered when the reflog has nothing to undo.
  assert.equal(planUndo({ head: [], oid: null, discard: { ...discard, at: 1 } }).kind, 'discard');
});
