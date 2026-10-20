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
  base = mkdtempSync(join(tmpdir(), 'tiller-repo-'));
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
