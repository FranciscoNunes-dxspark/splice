// Signed commits: reading %G?, the signing settings, when a key must be checked first, and the error a
// commit that can't be signed shows (a stand-in for gpg fails the way a locked key does).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import { explainSigning, needsPinentryCheck, signatureText, signingConfig } from '../src/signing.js';
import { commitDetail } from '../src/repo.js';

test('%G? as text, from good to bad', () => {
  assert.deepEqual(signatureText('G', 'Ana <a@x>'), { text: 'Good signature by Ana <a@x>', tone: 'good' });
  assert.equal(signatureText('B').tone, 'bad');
  assert.equal(signatureText('E').tone, 'wait');
  assert.deepEqual(signatureText('N'), { text: 'Not signed', tone: 'none' });
});

test('signing settings, and when the key is checked before committing', () => {
  const cfg = signingConfig('commit.gpgsign true\nuser.signingkey ABC123\ngpg.program /usr/bin/gpg2\n');
  assert.deepEqual(cfg, { commits: true, tags: false, format: 'openpgp', key: 'ABC123', program: '/usr/bin/gpg2' });
  assert.equal(signingConfig('').commits, false);
  assert.equal(needsPinentryCheck(cfg, { platform: 'linux', env: {} }), true, 'no display: only a terminal pinentry could ask');
  assert.equal(needsPinentryCheck(cfg, { platform: 'linux', env: { DISPLAY: ':0' } }), false);
  assert.equal(needsPinentryCheck(cfg, { platform: 'win32', env: {} }), false);
  assert.equal(needsPinentryCheck({ ...cfg, format: 'ssh' }, { platform: 'linux', env: {} }), false);
  assert.equal(needsPinentryCheck({ ...cfg, commits: false }, { platform: 'linux', env: {} }), false);
});

test('a signing failure is explained; other errors are not', () => {
  assert.match(explainSigning('error: gpg failed to sign the data\nfatal: failed to write commit object'), /^Signing failed: gpg couldn't sign/);
  assert.match(explainSigning('error: Load key "/k": incorrect passphrase supplied to decrypt private key?\nssh-keygen exited'), /ssh-add/);
  assert.equal(explainSigning("error: pathspec 'x' did not match"), null);
});

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-sign-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test("the commit pane says whether a commit is signed, and a commit that can't be signed says why", async () => {
  assert.equal((await commitDetail(dir, 'HEAD')).signature, 'N');
  // A gpg that fails as a locked key does without a terminal for its pinentry.
  const fake = join(base, 'fake-gpg');
  writeFileSync(fake, '#!/bin/sh\necho "gpg: signing failed: No pinentry" >&2\nexit 2\n');
  chmodSync(fake, 0o755);
  git('config', 'commit.gpgsign', 'true');
  git('config', 'gpg.format', 'openpgp');
  git('config', 'gpg.program', fake.replace(/\\/g, '/'));
  writeFileSync(join(dir, 'a.txt'), 'a\nb\n');
  git('add', '.');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('j');
    await until(() => frame().includes('Not signed'), 'the signature state in the commit pane');
    app.stdin.write('/');
    for (const ch of 'commit Second') app.stdin.write(ch);
    await until(() => frame().includes('/commit Second'), 'the typed command');
    app.stdin.write('\r');
    await until(() => frame().includes("Signing failed: gpg couldn't sign the commit"), 'the signing error');
    assert.equal(git('log', '--format=%s'), 'First commit');
  } finally {
    app.unmount();
    git('config', 'commit.gpgsign', 'false');
  }
});
