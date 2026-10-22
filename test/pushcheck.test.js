// The check before pushing: the pure scanner, then P against a throwaway repository with a bare remote.
// Secret-looking strings are built from pieces, so this file itself has none for a scanner to find.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { MB, bigFiles, checkCommits, findSecret, foundSummary, masked, parseBatchCheck, parsePushLog, pushCheckText, pushLogArgs, pushRange, scanCommit } from '../src/pushcheck.js';
import { App } from '../src/ui/App.jsx';

const AWS = 'AK' + 'IA' + 'Q3EGRT5MZ7WX4N2B';
const GH = 'gh' + 'p_' + 'Zx9Qw2'.repeat(6);
const GH_PAT = 'github' + '_pat_' + 'A1b2C3d4E5'.repeat(6);
const KEY = '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----';
const SLACK = 'xo' + 'xb-' + '1234567890-' + 'AbCdEfGhIjKl';

test('what looks like a secret, and what doesn\'t', () => {
  const kind = (line) => findSecret(line)?.rule.id ?? null;
  assert.equal(kind(`aws_access_key_id = ${AWS}`), 'aws');
  assert.equal(kind(`const token = '${GH}';`), 'github');
  assert.equal(kind(`TOKEN=${GH_PAT}`), 'github');
  assert.equal(kind(KEY), 'private-key');
  assert.equal(kind(`"slack": "${SLACK}"`), 'slack');
  assert.equal(kind('db_password = "Tr0ub4dor&3"'), 'password');
  assert.equal(kind('"apiKey": "f81Kq9zPl0Xw"'), 'password');
  assert.equal(kind("client_secret => 'h7Gk2LmQ9z'"), 'password');
  // Placeholders, lookups, names and plain words are left alone.
  for (const line of [
    'password = "changeme123"',
    'password: "${DB_PASSWORD}"',
    'password = "<your password>"',
    'apiKey: config.apiKey',
    'const pwd = process.env.PWD;',
    'secret = "aaaaaaaaaaaa"',
    'api_key = "MY_API_KEY_NAME"',
    'password = "correcthorse"',
    'private_key = "/etc/ssl/private/site.pem"',
    'token = "settings.auth.token"',
    'AKIA is how AWS keys start',
    'passwordHash = "x"',
  ]) {
    assert.equal(findSecret(line), null, line);
  }
  // Only the start of it is shown.
  const f = findSecret(`key = ${AWS}`);
  assert.equal(masked(f.rule, f.value), 'AKIA…');
  const p = findSecret('db_password = "Tr0ub4dor&3"');
  assert.equal(masked(p.rule, p.value), 'Tr…');
});

const ZERO = '0'.repeat(40);
const LOG = [
  `\x1e${'1'.repeat(40)}\x1fAdd the config`,
  '',
  `:000000 100644 ${ZERO} ${'a'.repeat(40)} A\tconfig/app.env`,
  `:100644 100644 ${'b'.repeat(40)} ${'c'.repeat(40)} M\tdata/dump.sql`,
  `:100644 000000 ${'d'.repeat(40)} ${ZERO} D\told.txt`,
  '',
  'diff --git a/config/app.env b/config/app.env',
  'new file mode 100644',
  'index 0000000..aaaaaaa',
  '--- /dev/null',
  '+++ b/config/app.env',
  '@@ -0,0 +1,3 @@',
  '+NAME=app',
  `+AWS_KEY=${AWS}`,
  '+++not a header',
  'diff --git a/data/dump.sql b/data/dump.sql',
  'index bbbbbbb..ccccccc 100644',
  'Binary files a/data/dump.sql and b/data/dump.sql differ',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index ddddddd..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  `-${GH}`,
  `\x1e${'2'.repeat(40)}\x1fTidy`,
  '',
  `:100644 100644 ${'e'.repeat(40)} ${'f'.repeat(40)} M\tsrc/x.js`,
  '',
  'diff --git a/src/x.js b/src/x.js',
  'index eeeeeee..fffffff 100644',
  '--- a/src/x.js',
  '+++ b/src/x.js',
  '@@ -10 +10 @@',
  '-old',
  '+new',
  '@@ -20,0 +21,2 @@',
  '+fine',
  `+${KEY}`,
  '',
].join('\n');

test('the log of the commits to push: their files, and the secrets in the lines they add', () => {
  const commits = parsePushLog(LOG);
  assert.deepEqual(
    commits.map((c) => [c.subject, c.files.map((f) => `${f.status} ${f.path} ${f.blob?.[0] ?? '-'}`)]),
    [
      ['Add the config', ['A config/app.env a', 'M data/dump.sql c', 'D old.txt -']],
      ['Tidy', ['M src/x.js f']],
    ],
  );
  // The removed token doesn't count; the added key does, on its line of the new file.
  assert.deepEqual(scanCommit(commits[0]).map((s) => [s.what, s.path, s.line, s.shown]), [['an AWS access key', 'config/app.env', 2, 'AKIA…']]);
  assert.deepEqual(scanCommit(commits[1]).map((s) => [s.what, s.path, s.line]), [['a private key', 'src/x.js', 22]]);

  const sizes = parseBatchCheck(`${'a'.repeat(40)} blob 120\n${'c'.repeat(40)} blob ${120 * MB}\n${'f'.repeat(40)} blob 51\nnope missing\n`);
  assert.deepEqual(bigFiles(commits, sizes).map((f) => [f.path, f.size, f.subject]), [['data/dump.sql', 120 * MB, 'Add the config']]);
  const found = checkCommits(commits, sizes);
  assert.equal(foundSummary(found), 'a file over 50 MB and 2 things that look like secrets');
  const text = pushCheckText(found);
  assert.match(text, /data\/dump\.sql {2}120 MB, over GitHub's 100 MB limit/);
  assert.match(text, /config\/app\.env:2 {2}an AWS access key \(AKIA…\)\n {6}in 1111111 Add the config/);
  assert.match(text, /Looked at 2 commits/);
  assert.doesNotMatch(text, new RegExp(AWS));
});

test('which commits are about to be pushed', () => {
  assert.deepEqual(pushRange({ upstream: 'origin/main' }), ['@{upstream}..HEAD']);
  assert.deepEqual(pushRange({ upstream: null }), ['HEAD', '--not', '--remotes']);
  assert.deepEqual(pushRange({ upstream: 'origin/main', remote: 'backup' }), ['HEAD', '--not', '--remotes=backup']);
  assert.deepEqual(pushRange({ upstream: 'origin/main', remote: 'origin' }), ['@{upstream}..HEAD']);
  const args = pushLogArgs(['@{upstream}..HEAD']);
  assert.deepEqual(args.slice(0, 3), ['-c', 'core.bigFileThreshold=2m', 'log']);
  assert.ok(args.includes('-U0') && args.includes('--raw') && args.at(-1) === '--');
});

let base;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-pushcheck-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function makeRepo(name) {
  const dir = join(base, name);
  const origin = join(base, `${name}.git`);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'First');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', '-u', 'origin', 'main');
  const remote = (...args) => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8' }).trim();
  return { dir, g, remote };
}

const start = (dir, config = {}) => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [], ...config } }));
  return lastApp;
};

test('P with a secret in the commits to push lists it and asks; no keeps it here, yes pushes', async () => {
  const { dir, g, remote } = makeRepo('secret-repo');
  writeFileSync(join(dir, 'deploy.sh'), `#!/bin/sh\nexport AWS_ACCESS_KEY_ID=${AWS}\n`);
  g('add', '.');
  g('commit', '-q', '-m', 'Deploy script');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Deploy script'), 'the graph');
    app.stdin.write('P');
    await until(() => frame().includes('Push anyway, with what looks like a secret?'), 'the question');
    assert.match(frame(), /deploy\.sh:2 {2}an AWS access key \(AKIA…\)/);
    assert.match(frame(), /in [0-9a-f]{7} Deploy script/);
    app.stdin.write('2');
    await until(() => !frame().includes('Push anyway'), 'the question gone');
    assert.equal(remote('log', '-1', '--format=%s', 'main'), 'First');
    app.stdin.write('P');
    await until(() => frame().includes('Push anyway, with what looks like a secret?'), 'the question again');
    app.stdin.write('1');
    await until(() => remote('log', '-1', '--format=%s', 'main') === 'Deploy script', 'the push');
  } finally {
    app.unmount();
  }
});

test('a new branch with a file over 50 MB asks before its first push; with the check off, P just pushes', async () => {
  const { dir, g, remote } = makeRepo('big-repo');
  g('switch', '-q', '-c', 'assets');
  writeFileSync(join(dir, 'video.bin'), Buffer.alloc(51 * MB));
  g('add', '.');
  g('commit', '-q', '-m', 'Add the video');
  let app = start(dir);
  let frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Add the video'), 'the graph');
    app.stdin.write('P');
    await until(() => frame().includes('Push anyway, with a file over 50 MB?'), 'the question');
    assert.match(frame(), /video\.bin {2}51 MB/);
    app.stdin.write('2');
    await until(() => !frame().includes('Push anyway'), 'the question gone');
    assert.equal(remote('branch', '--list', 'assets'), '');
  } finally {
    app.unmount();
  }
  app = start(dir, { checkBeforePush: false });
  frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Add the video'), 'the graph again');
    app.stdin.write('P');
    await until(() => remote('branch', '--list', 'assets').includes('assets'), 'the push', 20000);
    assert.doesNotMatch(frame(), /Push anyway/);
  } finally {
    app.unmount();
  }
});
