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
import { explainSigning, needsPinentryCheck, parseSignature, parseVerify, signatureLine, signatureText, signatureWord, signingConfig, unsignedOf, verifyArgs, verifyText } from '../src/signing.js';
import { commitDetail, commitSignature } from '../src/repo.js';

test('%G? as text, from good to bad', () => {
  assert.deepEqual(signatureText('G', 'Ana <a@x>'), { text: 'Good signature by Ana <a@x>', tone: 'good' });
  assert.equal(signatureText('B').tone, 'bad');
  assert.equal(signatureText('E').tone, 'wait');
  assert.deepEqual(signatureText('N'), { text: 'Not signed', tone: 'none' });
});

test('%G? in a word, a signature read with the signer and the key, and /verify\'s report', () => {
  assert.deepEqual(['G', 'U', 'X', 'Y', 'B', 'R', 'E', 'N', ''].map(signatureWord), ['Good', 'Good', 'Expired', 'Expired', 'Bad', 'Bad', 'Unknown', 'None', 'None']);
  assert.deepEqual(parseSignature('G\0Ana <a@x>\0ABC123\n'), { code: 'G', signer: 'Ana <a@x>', key: 'ABC123' });
  assert.deepEqual(parseSignature('N\0\0\n'), { code: 'N', signer: '', key: '' });
  assert.deepEqual(signatureLine({ code: 'G', signer: 'Ana', key: 'ABC' }), { word: 'Good', text: 'Good signature by Ana (key ABC)', tone: 'good' });
  assert.equal(signatureLine({ code: 'N', signer: '', key: '' }).word, 'None');
  assert.deepEqual(verifyArgs(['@{upstream}..HEAD']).slice(-2), ['@{upstream}..HEAD', '--']);
  const list = parseVerify(`${'a'.repeat(40)}\0G\0Ana\0K1\0Signed one\x1e\n${'b'.repeat(40)}\0N\0\0\0Plain one\x1e\n${'c'.repeat(40)}\0B\0Eve\0K2\0Tampered\x1e\n`);
  assert.deepEqual(list.map((c) => [c.hash[0], c.code, c.subject]), [['a', 'G', 'Signed one'], ['b', 'N', 'Plain one'], ['c', 'B', 'Tampered']]);
  assert.deepEqual(unsignedOf(list).map((c) => c.subject), ['Plain one', 'Tampered']);
  const text = verifyText(list, 'the commits to push');
  assert.match(text, /^2 of the 3 commits in the commits to push aren't signed, or have a bad signature\./);
  assert.ok(text.indexOf('Bad signatures (1)') < text.indexOf('Not signed (1)') && text.indexOf('Not signed (1)') < text.indexOf('Good signatures (1)'), 'the bad first, the good last');
  assert.match(text, /cccccc {2}Tampered {2}· Eve {2}· Bad signature by Eve/);
  assert.match(verifyText(list.slice(0, 1), 'x'), /^Every commit in x is signed \(1\)\./);
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
  assert.equal((await commitDetail(dir, 'HEAD')).signature, undefined, 'the detail never checks a signature');
  assert.equal((await commitSignature(dir, git('rev-parse', 'HEAD'))).code, 'N');
  // A gpg that fails as a locked key does without a terminal for its pinentry.
  const fake = join(base, 'fake-gpg');
  writeFileSync(fake, '#!/bin/sh\necho "gpg: signing failed: No pinentry" >&2\nexit 2\n');
  chmodSync(fake, 0o755);
  git('config', 'commit.gpgsign', 'true');
  git('config', 'gpg.format', 'openpgp');
  git('config', 'gpg.program', fake.replace(/\\/g, '/'));
  writeFileSync(join(dir, 'a.txt'), 'a\nb\n');
  git('add', '.');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [], showSignatures: true } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('j');
    await until(() => frame().includes('None: Not signed'), 'the signature state in the commit pane');
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

test('signatures stay unchecked until Show signatures is on; /verify lists the unsigned; a push with commit.gpgsign on asks first', async () => {
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('remote', 'add', 'origin', origin);
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir, stdio: 'pipe' });
  for (const n of ['2', '3']) {
    writeFileSync(join(dir, `n${n}.txt`), `${n}\n`);
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Unsigned ${n}`);
  }
  git('config', 'commit.gpgsign', 'true');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const type = async (text) => {
    app.stdin.write('/');
    await until(() => frame().includes('> /'), 'the prompt');
    for (const ch of text) app.stdin.write(ch);
    await until(() => frame().includes(`> /${text}`), `/${text} typed`);
    app.stdin.write('\r');
  };
  try {
    await until(() => frame().includes('Unsigned 3') && frame().includes('1 file changed'), 'the graph and the commit pane');
    assert.doesNotMatch(frame(), /Not signed|Checking the signature/, 'nothing checked with the setting off');

    await type('verify');
    await until(() => frame().includes('Signatures: 2 not signed or bad (2)'), "/verify's report");
    assert.match(frame(), /Not signed \(2\)/);
    assert.match(frame(), /Unsigned 3/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Signatures:'), 'the report closed');

    app.stdin.write('P');
    await until(() => frame().includes("Push 2 commits that aren't signed?"), 'the question before pushing');
    assert.match(frame(), /commit\.gpgsign is on here/);
    app.stdin.write('2');
    await until(() => !frame().includes("Push 2 commits that aren't signed?"), 'no');
    assert.notEqual(execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'), 'not pushed');
    app.stdin.write('P');
    await until(() => frame().includes("Push 2 commits that aren't signed?"), 'asked again');
    app.stdin.write('1');
    await until(() => execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8' }).trim() === git('rev-parse', 'HEAD'), 'pushed');
  } finally {
    app.unmount();
    git('config', 'commit.gpgsign', 'false');
  }
});
