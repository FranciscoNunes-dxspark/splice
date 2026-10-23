// Loading against a real throwaway repository: what's reused between loads must still notice changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './temp.js';
import { commitDetail, findRepo, loadRepo, snapshot } from '../src/repo.js';

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-repo-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First');
  git('switch', '-q', '-c', 'side');
  writeFileSync(join(dir, 'b.txt'), 'side\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Side work');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'Second');
  git('merge', '-q', '--no-edit', 'side');
  git('tag', '-a', 'v1', '-m', 'Version 1');
  git('tag', 'light');
});

after(() => removeTemp(base));

test('a load and a poll agree on the signature, so polling only reloads on real changes', async () => {
  const repo = await findRepo(dir);
  git('stash', 'push', '-q', '-m', 'nothing yet'); // no changes: makes no stash
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  git('stash', 'push', '-q', '-m', 'one');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  const data = await loadRepo(repo);
  assert.equal(data.signature, (await snapshot(repo)).signature);
  assert.deepEqual(data.refs.tags.map((t) => t.name).sort(), ['light', 'v1']);
  writeFileSync(join(dir, 'a.txt'), 'edited again\n');
  assert.notEqual(data.signature, (await snapshot(repo)).signature);
  git('checkout', '-q', '--', 'a.txt');
  rmSync(join(dir, 'new.txt'));
  git('stash', 'drop', '-q');
});

test('stashes and remotes are read again when they change', async () => {
  const repo = await findRepo(dir);
  assert.deepEqual((await loadRepo(repo)).stashes, []);
  for (const n of ['first', 'second', 'third']) {
    writeFileSync(join(dir, 'a.txt'), `${n}\n`);
    git('stash', 'push', '-q', '-m', n);
  }
  assert.deepEqual((await loadRepo(repo)).stashes.map((s) => s.message), ['On main: third', 'On main: second', 'On main: first']);
  // Dropping one below the top leaves refs/stash alone; only the reflog changes.
  git('stash', 'drop', '-q', 'stash@{1}');
  assert.deepEqual((await loadRepo(repo)).stashes.map((s) => s.message), ['On main: third', 'On main: first']);
  git('stash', 'clear');
  assert.deepEqual((await loadRepo(repo)).stashes, []);

  assert.deepEqual((await loadRepo(repo)).remotes, []);
  git('remote', 'add', 'origin', 'https://github.com/you/repo.git');
  const data = await loadRepo(repo);
  assert.deepEqual(data.remotes, ['origin']);
  assert.equal(data.remoteUrls.origin, 'https://github.com/you/repo.git');
  git('remote', 'remove', 'origin');
});

test('worktrees: just the open one until another is added', async () => {
  const repo = await findRepo(dir);
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(
    (await loadRepo(repo)).worktrees.map((w) => [w.path, w.branch, w.head, w.main, w.current]),
    [[repo.root, 'main', head, true, true]],
  );
  git('worktree', 'add', '-q', '-b', 'wt', '../repo-wt');
  const list = (await loadRepo(repo)).worktrees;
  assert.deepEqual(list.map((w) => [w.branch, w.main, w.current]), [['main', true, true], ['wt', false, false]]);
  // Opened from the linked one, it shares the main repo's stash and config.
  const linked = await findRepo(join(base, 'repo-wt'));
  assert.equal(linked.commonDir, repo.commonDir);
  assert.deepEqual((await loadRepo(linked)).worktrees.map((w) => w.current), [false, true]);
  git('worktree', 'remove', '../repo-wt');
});

test('the graph is kept while nothing it shows changed, and read again when any ref, HEAD or the limit does', async () => {
  const repo = await findRepo(dir);
  const hashes = (d) => d.graph.filter((r) => r.commit).map((r) => r.commit.hash);
  const fresh = () => git('log', '--date-order', '--format=%H', '--exclude=refs/stash', '--all').split('\n');
  await loadRepo(repo);
  const first = await loadRepo(repo);
  // Changes in the working tree leave the log as it was: the same graph, rows and all.
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  const dirty = await loadRepo(repo);
  writeFileSync(join(dir, 'a.txt'), 'edited again\n');
  const again = await loadRepo(repo);
  assert.equal(again.graph, dirty.graph);
  assert.equal(again.signature, (await snapshot(repo)).signature);
  assert.deepEqual(hashes(again), hashes(first));
  git('checkout', '-q', '--', 'a.txt');
  // A commit only a ref outside the views' refs reaches still shows, as git log --all shows it.
  const tree = git('rev-parse', 'HEAD^{tree}');
  const loose = git('commit-tree', tree, '-p', 'HEAD', '-m', 'Kept elsewhere');
  git('update-ref', 'refs/keep/x', loose);
  const kept = await loadRepo(repo);
  assert.deepEqual(hashes(kept), fresh());
  assert.equal(kept.signature, (await snapshot(repo)).signature);
  git('update-ref', '-d', 'refs/keep/x');
  assert.deepEqual(hashes(await loadRepo(repo)), fresh());
  // HEAD moving to a commit already in the graph changes where HEAD is drawn.
  git('checkout', '-q', '--detach', 'HEAD^1');
  const detached = await loadRepo(repo);
  assert.ok(detached.graph.find((r) => r.commit?.hash === git('rev-parse', 'HEAD')).commit.refs.some((r) => r.type === 'head'));
  git('checkout', '-q', 'main');
  const back = await loadRepo(repo);
  assert.ok(back.graph.find((r) => r.commit?.hash === git('rev-parse', 'HEAD')).commit.refs.some((r) => r.name === 'main' && r.head));
  // A smaller limit is a new log.
  assert.equal((await loadRepo(repo, { graphLimit: 2 })).graph.filter((r) => r.commit).length, 2);
  assert.equal(hashes(await loadRepo(repo)).length, fresh().length);
});

test('polling notices every way a ref changes, though it lists them only when their files changed', async () => {
  const repo = await findRepo(dir);
  let last = (await loadRepo(repo)).signature;
  const changed = async (what) => {
    const sig = (await snapshot(repo)).signature;
    assert.notEqual(sig, last, what);
    assert.equal(sig, (await loadRepo(repo)).signature, what);
    assert.equal((await snapshot(repo)).signature, sig, what);
    last = sig;
  };
  assert.equal((await snapshot(repo)).signature, last);
  git('branch', 'poll-a');
  await changed('a branch made');
  git('update-ref', 'refs/heads/poll-a', 'HEAD~1');
  await changed('a branch moved');
  git('tag', 'release/poll-1');
  await changed('a tag in a folder of its own');
  git('pack-refs', '--all');
  assert.equal((await snapshot(repo)).signature, last, 'packing changes no ref');
  git('update-ref', 'refs/heads/poll-a', 'HEAD');
  await changed('a packed branch moved');
  git('tag', '-d', 'release/poll-1');
  await changed('a packed tag deleted');
  git('update-ref', 'refs/remotes/origin/poll-a', 'HEAD');
  await changed('a remote branch fetched');
  git('branch', '-D', 'poll-a');
  git('update-ref', '-d', 'refs/remotes/origin/poll-a');
  await changed('both deleted');
});

test('commit detail: header and files from one git, for plain, merge and root commits', async () => {
  for (const rev of ['HEAD', 'HEAD^1', git('rev-list', '--max-parents=0', 'HEAD')]) {
    const hash = git('rev-parse', rev);
    const d = await commitDetail(dir, hash);
    assert.equal(d.hash, hash);
    assert.equal(d.message, git('log', '-1', '--format=%B', hash));
    assert.deepEqual(d.parents, git('log', '-1', '--format=%P', hash).split(' ').filter(Boolean));
    const files = git('show', '--format=', '--name-status', '-M', '--diff-merges=first-parent', hash)
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t').at(-1));
    assert.deepEqual(d.files.map((f) => f.path), files);
  }
});
