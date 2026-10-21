import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { READ_ONLY, blameInput, blamePrompt, cleanSubject, clip, commitPrompt, parseCommitMessage, parsePrDraft } from '../src/claude.js';
import { prArgs } from '../src/actions.js';
import { App } from '../src/ui/App.jsx';

test('the commit subject is the first line of the answer, without quotes or a label', () => {
  assert.equal(cleanSubject('Add worktrees view\n\nMore text'), 'Add worktrees view');
  assert.equal(cleanSubject('\n  "Fix the  poll"  \n'), 'Fix the poll');
  assert.equal(cleanSubject('Subject: `Drop the cache`'), 'Drop the cache');
  assert.equal(cleanSubject("Don't reload twice"), "Don't reload twice");
  assert.equal(cleanSubject(''), '');
});

test('a pull request draft splits into a title and a description', () => {
  assert.deepEqual(parsePrDraft('# Faster loading\n\nFewer git processes.\n\n- one\n- two\n'), {
    title: 'Faster loading',
    body: 'Fewer git processes.\n\n- one\n- two',
  });
  assert.deepEqual(parsePrDraft('\n\nTitle only'), { title: 'Title only', body: '' });
  assert.deepEqual(parsePrDraft(''), { title: '', body: '' });
});

test('a commit message from Claude: a subject, and a body when it wrote one', () => {
  assert.deepEqual(parseCommitMessage('Add worktrees view'), { subject: 'Add worktrees view', body: '' });
  assert.deepEqual(parseCommitMessage('\n"Fix the poll"\n\n\n\nIt reloaded twice   \nper tick.\n\n'), { subject: 'Fix the poll', body: 'It reloaded twice\nper tick.' });
  assert.deepEqual(parseCommitMessage('```text\r\nSubject: Drop the cache\r\n\r\nBody: Nothing read it.\r\n```'), { subject: 'Drop the cache', body: 'Nothing read it.' });
  assert.deepEqual(parseCommitMessage(''), { subject: '', body: '' });
});

test('the commit prompt shows recent subjects, and their bodies indented, cut when long', () => {
  const p = commitPrompt(['Add the thing\n\nBecause it was missing.\nTwo lines.', 'Fix the other', `Long one\n\n${'x'.repeat(700)}`]);
  assert.match(p, /- Add the thing\n {2}Because it was missing\.\n {2}Two lines\.\n- Fix the other\n- Long one\n {2}x{600}…\n?/);
  assert.match(p, /blank line and a short body/);
  assert.match(p, /subject alone/);
});

test('explaining blame lines: the lines with their commits, the file around them, and their history', () => {
  const commit = (hash, summary) => ({ hash: hash.repeat(40), author: 'Ana', time: 1700000000, tz: '+0000', summary, uncommitted: false });
  const a = commit('a', 'Start the file');
  const b = commit('b', 'Shout line two');
  const rows = [
    { line: 8, text: 'one', commit: a },
    { line: 9, text: 'TWO', commit: b },
    { line: 10, text: 'new', commit: { uncommitted: true } },
  ];
  const input = blameInput({ path: 'src/f.js', lines: rows.slice(1), around: rows, history: 'commit bbb\n\n    Shout line two\n' });
  assert.match(input, /^File: src\/f\.js, as it is in the working tree\n\nLines 9–10, each with the commit that last changed it:\n 9 │ TWO {4}\[bbbbbbb Ana, 2023-11-14: Shout line two\]\n10 │ new {4}\[not committed yet\]/);
  assert.match(input, /The file around them \(lines 8–10\):\n 8 │ one\n 9 │ TWO\n10 │ new\n/);
  assert.match(input, /git log -L\), newest first:\ncommit bbb\n\n {4}Shout line two$/);
  const one = blameInput({ path: 'f', rev: 'abc1234', lines: [rows[0]], around: rows.slice(0, 1), history: '' });
  assert.match(one, /^File: f as of abc1234\n\nLine 8, each/);
  assert.match(one, /None: the lines are not committed yet\.$/);
  // A long history is cut, saying so.
  assert.match(blameInput({ path: 'f', lines: [rows[0]], around: [rows[0]], history: 'y'.repeat(90_000) }), /\[Cut here: the rest \(10,000 more characters\)/);
  assert.match(blamePrompt('src/f.js', 9, 10), /^Explain why lines 9–10 of src\/f\.js are the way they are/);
  assert.match(blamePrompt('src/f.js', 9, 9), /^Explain why line 9 of src\/f\.js is the way it is/);
  assert.match(blamePrompt('f', 1, 1), /formats Markdown/);
});

test('/pr arguments: flags anywhere, and the title kept as typed', () => {
  assert.deepEqual(prArgs("Don't show old apps --into develop --draft"), { target: 'develop', draft: true, title: "Don't show old apps" });
  assert.deepEqual(prArgs('--base main  Faster   loading'), { target: 'main', draft: false, title: 'Faster loading' });
  assert.deepEqual(prArgs('Fix --drafted wording'), { target: null, draft: false, title: 'Fix --drafted wording' });
  assert.deepEqual(prArgs(''), { target: null, draft: false, title: '' });
});

test('prompts carry the repository style, and big inputs are cut with a note', () => {
  assert.match(commitPrompt(['Add the thing', 'Fix the other']), /- Add the thing\n- Fix the other/);
  assert.match(commitPrompt([]), /imperative/);
  assert.equal(clip('short', 10), 'short');
  const cut = clip('x'.repeat(30), 10);
  assert.ok(cut.startsWith('x'.repeat(10)));
  assert.match(cut, /20 more characters/);
});

test('through the UI: Claude writes the commit message, then explains and reviews', async () => {
  const base = mkdtempSync(join(tmpdir(), 'splice-claude-'));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const prevHome = process.env.SPLICE_HOME;
  process.env.SPLICE_HOME = join(base, 'home');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  // No background maintenance after the commit, holding the folder open while the test cleans up.
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Start the notes');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', 'a.txt');

  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    if (/commit message/.test(prompt)) return '"Add a second note"';
    return `Answer number ${asked.length}. ${'This sentence is long enough that the viewer has to wrap it onto more lines. '.repeat(3)}`;
  };
  const app = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, askClaude }));
  const frame = () => app.lastFrame() ?? '';
  const until = async (check, what) => {
    const end = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
      await new Promise((r) => setTimeout(r, 40));
    }
    // Let the newly shown view's key handler subscribe before the next key.
    await new Promise((r) => setTimeout(r, 100));
  };
  try {
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)'), 'the Changes view');
    app.stdin.write('W');
    await until(() => frame().includes('/commit Add a second note'), 'the message in the prompt');
    const first = asked[0];
    assert.match(first.prompt, /- Start the notes/);
    assert.match(first.input, /\+two/);
    assert.deepEqual(first.tools, []);
    // The repository root as git names it (the temp path may come in a Windows short form).
    assert.equal(first.cwd, resolve(git('rev-parse', '--show-toplevel')));
    app.stdin.write('\r');
    await until(() => git('log', '-1', '--format=%s') === 'Add a second note', 'the commit');

    app.stdin.write('1');
    await until(() => /❯ ●.*Add a second note/.test(frame()), 'the graph on the new commit');
    app.stdin.write('e');
    await until(() => frame().includes('Claude explains') && frame().includes('Answer number 2.'), 'the explanation');
    assert.match(asked[1].input, /Add a second note[\s\S]*\+two/);
    assert.deepEqual(asked[1].tools, READ_ONLY);
    // Wrapped: the long answer goes over several rows rather than off the edge.
    assert.ok(frame().split('\n').filter((l) => l.includes('wrap it onto more lines')).length >= 2);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Claude explains'), 'the viewer to close');

    app.stdin.write('2');
    await until(() => frame().includes('Staged (0)'), 'Changes, now clean');
    app.stdin.write('R');
    await until(() => frame().includes('no changes to look at'), 'the note that there is nothing to review');
    assert.equal(asked.length, 2);
  } finally {
    app.unmount();
    if (prevHome === undefined) delete process.env.SPLICE_HOME;
    else process.env.SPLICE_HOME = prevHome;
    // On Windows a git still finishing for the unmounted app keeps the folder busy for a moment.
    await removeTemp(base);
  }
});
