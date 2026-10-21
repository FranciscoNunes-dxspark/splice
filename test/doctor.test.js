// /doctor: the pure parts (parsing what git says, deciding what to report), then the report and its fixes
// through the real UI against a throwaway repository with a bare remote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import {
  doctorFindings,
  doctorText,
  hasCredentialHelper,
  ignoreLines,
  parseConfigList,
  parseCountObjects,
  parseEol,
  parseGitVersion,
  parseStashPatches,
  signingProblem,
} from '../src/doctor.js';
import { MB } from '../src/pushcheck.js';
import { signingConfig } from '../src/signing.js';
import { App } from '../src/ui/App.jsx';

test('reading what git says', () => {
  assert.deepEqual(parseGitVersion('git version 2.45.1.windows.1\n'), [2, 45, 1]);
  assert.deepEqual(parseGitVersion('git version 2.39.3 (Apple Git-146)'), [2, 39, 3]);
  assert.equal(parseGitVersion(''), null);

  const config = parseConfigList('core.autocrlf\ninput\0credential.helper\nmanager\0credential.helper\n\0user.name\nAna\0core.bare\0');
  assert.deepEqual(config.get('credential.helper'), ['manager', '']);
  assert.deepEqual(config.get('core.bare'), ['true']);

  assert.deepEqual(parseCountObjects('count: 7012\nsize: 30500\nin-pack: 10\npacks: 3\nsize-pack: 12\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n'), {
    count: 7012,
    size: 30500,
    packs: 3,
    sizePack: 12,
  });
  assert.deepEqual(parseEol('i/crlf  w/crlf  attr/text=auto         \tdocs/a b.txt\0i/lf    w/lf    attr/                 \tsrc/x.js\0'), [
    { index: 'crlf', work: 'crlf', attr: 'text=auto', path: 'docs/a b.txt' },
    { index: 'lf', work: 'lf', attr: '', path: 'src/x.js' },
  ]);
  assert.deepEqual(
    parseStashPatches('\x1estash@{0}\n\ndiff --git a/x b/x\n+y\n\x1estash@{1}\n\n').map((s) => [s.ref, s.patch]),
    [
      ['stash@{0}', 'diff --git a/x b/x\n+y\n'],
      ['stash@{1}', ''],
    ],
  );
  assert.deepEqual(ignoreLines(['big.bin', 'out/#1 [final].mp4', '!x']), ['/big.bin', '/out/#1 \\[final\\].mp4', '/!x']);
});

test('a credential helper, set for everything or for a URL; an empty value clears the ones before it', () => {
  const cfg = (raw) => parseConfigList(raw);
  assert.equal(hasCredentialHelper(cfg('credential.helper\nstore\0'), 'https://github.com/a/b.git'), true);
  assert.equal(hasCredentialHelper(cfg('credential.helper\nstore\0credential.helper\n\0'), 'https://github.com/a/b.git'), false);
  assert.equal(hasCredentialHelper(cfg('credential.https://github.com.helper\nmanager\0'), 'https://github.com/a/b.git'), true);
  assert.equal(hasCredentialHelper(cfg('credential.https://dev.azure.com.helper\nmanager\0'), 'https://github.com/a/b.git'), false);
  assert.equal(hasCredentialHelper(cfg(''), 'https://github.com/a/b.git'), false);
});

test('signing problems', () => {
  const cfg = (raw) => signingConfig(raw);
  assert.equal(signingProblem(cfg('commit.gpgsign false')), null);
  assert.match(signingProblem(cfg('commit.gpgsign true\ngpg.format ssh')), /names no key/);
  assert.match(signingProblem(cfg('commit.gpgsign true\ngpg.format ssh\nuser.signingkey ~/.ssh/k.pub'), { keyFile: { path: '~/.ssh/k.pub', exists: false } }), /k\.pub, isn't there/);
  assert.equal(signingProblem(cfg('commit.gpgsign true\ngpg.format ssh\nuser.signingkey ~/.ssh/k.pub'), { keyFile: { path: '~/.ssh/k.pub', exists: true } }), null);
  const pgp = cfg('commit.gpgsign true\nuser.signingkey ABCD');
  assert.match(signingProblem(pgp, { gpgError: 'spawn gpg ENOENT' }), /gpg isn't installed/);
  assert.match(signingProblem(pgp, { gpgError: 'gpg: skipped "ABCD": No secret key' }), /no usable secret key for ABCD/);
  // Locked: fine where a pinentry window can ask, a problem where nothing can.
  assert.equal(signingProblem(pgp, { gpgError: 'gpg: signing failed: No pinentry', pinentry: false }), null);
  assert.match(signingProblem(pgp, { gpgError: 'gpg: signing failed: No pinentry', pinentry: true }), /locked/);
  assert.equal(signingProblem(pgp, { gpgError: null }), null);
});

const NOW = 1_800_000_000;

test('the findings, most pressing first, with what Splice can do itself', () => {
  const findings = doctorFindings({
    now: NOW,
    platform: 'linux',
    gitVersion: [2, 30, 0],
    branch: { head: null, oid: 'a'.repeat(40) },
    config: parseConfigList('core.autocrlf\ntrue\0'),
    env: {},
    remotes: ['origin', 'mirror'],
    remoteUrls: { origin: 'git@github.com:a/b.git', mirror: 'https://user:s3cretT0ken@example.com/b.git' },
    local: [
      { name: 'main', upstream: 'origin/main' },
      { name: 'topic', upstream: null },
      { name: 'local-only', upstream: null },
    ],
    remoteBranches: ['origin/main', 'origin/topic', 'mirror/topic'],
    stashes: [
      { ref: 'stash@{0}', time: NOW - 100, message: 'On main: done already', inHead: true },
      { ref: 'stash@{1}', time: NOW - 45 * 86400, message: 'On main: old idea', inHead: false },
      { ref: 'stash@{2}', time: NOW - 2 * 86400, message: 'On main: recent', inHead: false },
    ],
    eol: [
      { index: 'crlf', work: 'crlf', attr: 'text=auto', path: 'a.txt' },
      { index: 'crlf', work: 'crlf', attr: '-text', path: 'b.bat' },
      { index: 'lf', work: 'lf', attr: 'text', path: 'c.txt' },
    ],
    untracked: [{ path: 'dump.sql', size: 12 * MB }],
    committed: [{ path: 'video.mp4', size: 30 * MB, hash: 'b'.repeat(40), subject: 'Add the video' }],
    objects: { count: 9000, size: 40000, packs: 2, sizePack: 100 },
    signing: "commit.gpgsign is on, but gpg isn't installed",
    signingFix: 'Install gpg',
  });
  assert.deepEqual(findings.map((f) => f.id), [
    'git',
    'detached',
    'signing',
    'url-password',
    'credentials',
    'upstream',
    'stash-in-head',
    'stash-old',
    'eol',
    'autocrlf',
    'untracked-big',
    'committed-big',
    'gc',
  ]);
  const by = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.match(by.git.title, /Git 2\.30\.0 is older/);
  assert.deepEqual(by.git.lines.map((l) => l.split(':')[0]), ['2.31', '2.36']);
  assert.match(by.credentials.title, /mirror \(https\)/);
  assert.match(by.credentials.fix, /libsecret/);
  // Only a branch whose name is on a remote counts as pushed, and origin comes first.
  assert.deepEqual(by.upstream.action.items, [{ branch: 'topic', upstream: 'origin/topic' }]);
  assert.deepEqual(by['stash-in-head'].action.refs, ['stash@{0}']);
  assert.equal(by['stash-in-head'].action.danger, true);
  assert.deepEqual(by['stash-old'].lines, ['stash@{1}: On main: old idea (45 days)']);
  assert.deepEqual(by.eol.lines, ['a.txt (text=auto)']);
  assert.deepEqual(by['untracked-big'].action.paths, ['dump.sql']);
  assert.equal(by['committed-big'].action, null);
  assert.match(by.gc.title, /9000 loose objects/);

  const text = doctorText(findings);
  assert.match(text, /^1\. Git 2\.30\.0 is older than Splice needs\n {3}2\.31: /);
  assert.match(text, /\n {3}→ Pack them \(git gc\)\./);
  assert.match(text, /Splice can do 5 of these for you: answer below\.$/);
  assert.doesNotMatch(text, /s3cretT0ken/);
});

test('a healthy repository has nothing to report', () => {
  const findings = doctorFindings({
    now: NOW,
    platform: 'win32',
    gitVersion: [2, 45, 0],
    branch: { head: 'main', oid: 'a'.repeat(40) },
    config: parseConfigList('core.autocrlf\ntrue\0credential.helper\nmanager\0'),
    env: {},
    remotes: ['origin'],
    remoteUrls: { origin: 'https://github.com/a/b.git' },
    local: [{ name: 'main', upstream: 'origin/main' }],
    remoteBranches: ['origin/main'],
    stashes: [{ ref: 'stash@{0}', time: NOW - 86400, message: 'WIP', inHead: false }],
    eol: [],
    untracked: [],
    committed: [],
    objects: { count: 30, size: 100, packs: 1, sizePack: 100 },
    signing: null,
  });
  assert.deepEqual(findings, []);
  // Detached in the middle of a rebase is how a rebase works, not something to fix.
  assert.deepEqual(doctorFindings({ branch: { head: null, oid: 'a'.repeat(40) }, state: 'rebasing' }), []);
});

let base;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-doctor-'));
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

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('/doctor reports what it finds, then sets the upstream, drops the stash already in HEAD and ignores the big file', async () => {
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g('add', '.');
  g('commit', '-q', '-m', 'First');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', '-u', 'origin', 'main');
  // Pushed, but without -u: it doesn't track origin/topic.
  g('branch', 'topic');
  g('push', '-q', 'origin', 'topic');
  // A stash, then the same change committed: the stash has nothing HEAD doesn't.
  writeFileSync(join(dir, 'a.txt'), 'a, changed\n');
  g('stash', 'push', '-q', '-m', 'the change, before committing it');
  writeFileSync(join(dir, 'a.txt'), 'a, changed\n');
  g('commit', '-q', '-am', 'The change');
  // And one made 40 days ago, of something HEAD doesn't have.
  const old = `@${Math.floor(Date.now() / 1000) - 40 * 86400} +0000`;
  writeFileSync(join(dir, 'b.txt'), 'b, an old idea\n');
  execFileSync('git', ['stash', 'push', '-q', '-m', 'an old idea'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(11 * MB));

  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('The change'), 'the graph');
    app.stdin.write('/');
    await type(app.stdin, 'doctor');
    await until(() => frame().includes('/doctor'), 'the typed command');
    app.stdin.write('\r');
    await until(() => frame().includes('Do 3 of these now?'), 'the report and the question');
    assert.match(frame(), /Doctor: 4 things to look at/);
    assert.match(frame(), /1 branch pushed, but not tracking it/);
    assert.match(frame(), /topic: origin\/topic is there/);
    assert.match(frame(), /1 stash whose changes are already in HEAD/);
    assert.match(frame(), /stash@\{1\}: On main: the change, before committing it/);
    assert.match(frame(), /1 stash older than 30 days/);
    assert.match(frame(), /stash@\{0\}: On main: an old idea \(40 days\)/);
    assert.match(frame(), /1 untracked file over 10 MB/);
    assert.match(frame(), /big\.bin {2}11 MB/);
    app.stdin.write('1');
    await until(() => frame().includes('Done: '), 'the fixes');
    assert.equal(g('rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
    assert.equal(g('stash', 'list', '--format=%gs'), 'On main: an old idea');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '/big.bin\n');
  } finally {
    app.unmount();
  }
});
