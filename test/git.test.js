// The one way git is started: its output and errors, cancelling, and (off Windows) a session of its own,
// so nothing it runs can reach the terminal Splice draws on.
import { removeTemp } from './temp.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, git, run } from '../src/git.js';

const dir = mkdtempSync(join(tmpdir(), 'splice-git-'));
execFileSync('git', ['init', '-q', dir]);
after(() => removeTemp(dir));

test('git gives its output, and its own words when it fails', async () => {
  assert.equal((await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim(), 'true');
  const err = await run(dir, ['rev-parse', 'no-such-ref']).catch((e) => e);
  assert.ok(err instanceof GitError);
  assert.match(err.message, /no-such-ref/);
  assert.equal(typeof err.code, 'number');
});

test('input goes to git on stdin, and without any git reads an end at once', async () => {
  assert.match(await git(dir, ['hash-object', '--stdin'], { input: 'hello\n' }), /^ce013625030ba8dba906f756967f9e9ca394464a/);
  assert.match(await git(dir, ['hash-object', '--stdin']), /^e69de29bb2d1d6434b8b29ae775ad8c2e48c5391/);
});

test('cancelling stops git', async () => {
  const ac = new AbortController();
  const p = run(dir, ['-c', 'alias.wait=!sleep 5', 'wait'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const err = await p.catch((e) => e);
  assert.equal(err.cancelled, true);
});

test('off Windows, git runs in a session of its own', { skip: process.platform === 'win32' }, async () => {
  const sid = (pid) => execFileSync('ps', ['-o', 'sid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const theirs = (await git(dir, ['-c', 'alias.sid=!ps -o sid= -p $$', 'sid'])).trim();
  assert.notEqual(theirs, sid(process.pid));
});
