// CODEOWNERS: the patterns and sections (pure), then through the UI against a throwaway repository: the
// owners beside a file in Changes and in blame's title, /owners, and the reviewers offered for a new PR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { changedOwnersText, ownersLine, ownersOf, ownersOfFiles, ownersText, parseCodeowners, patternRegex, reviewerNames } from '../src/codeowners.js';
import { readCodeowners } from '../src/repo.js';
import { App } from '../src/ui/App.jsx';

const owners = (text, path) => ownersOf(parseCodeowners(text), path).owners;

test("GitHub's patterns: anchoring, *, **, folders, and the last match wins", () => {
  const file = [
    '# Everyone, unless a later line says otherwise',
    '*       @global',
    '*.js    @js-owner  # a comment after the owners',
    '/build/logs/ @doctocat',
    'docs/*  docs@example.com',
    'apps/   @octocat',
    '/scripts/ @doctocat @octocat',
    '**/logs @logs',
    '/apps/github',
    'src/**/test.js @tests',
  ].join('\n');
  assert.deepEqual(owners(file, 'README.md'), ['@global']);
  assert.deepEqual(owners(file, 'src/deep/a.js'), ['@js-owner']);
  assert.deepEqual(owners(file, 'build/logs/x.txt'), ['@logs'], '**/logs comes later than /build/logs/');
  assert.deepEqual(owners(file, 'docs/getting-started.md'), ['docs@example.com']);
  assert.deepEqual(owners(file, 'docs/build-app/troubleshooting.md'), ['@global'], 'docs/* is only the files right in docs');
  assert.deepEqual(owners(file, 'web/apps/x.txt'), ['@octocat'], 'apps/ anywhere');
  assert.deepEqual(owners(file, 'apps/github/x.txt'), [], 'a line with no owners leaves its files with none');
  assert.deepEqual(owners(file, 'scripts/run.sh'), ['@doctocat', '@octocat']);
  assert.deepEqual(owners(file, 'other/scripts/run.sh'), ['@global'], '/scripts/ is anchored');
  assert.deepEqual(owners(file, 'src/test.js'), ['@tests'], '**/ can be no folder at all');
  assert.deepEqual(owners(file, 'src/a/b/test.js'), ['@tests']);
  assert.deepEqual(owners(file, 'a/logs'), ['@logs']);
  assert.equal(patternRegex('apps/').test('apps'), false, 'a folder pattern is what is in it');
  assert.equal(patternRegex('docs').test('docs/a/b.md'), true, 'a name matches a folder of that name, and all in it');
  assert.equal(patternRegex('\\#notes').test('#notes'), true, 'an escaped #');
  assert.equal(patternRegex('a?.txt').test('ab.txt'), true);
  assert.equal(patternRegex('a?.txt').test('a/.txt'), false);
  // Windows paths are compared with forward slashes.
  assert.deepEqual(owners(file, 'scripts\\run.sh'), ['@doctocat', '@octocat']);
});

test("GitLab's sections: each has its say, default owners, optional and approvals, ! left out", () => {
  const file = [
    '* @admins',
    '[Docs][2] @docs-team',
    'docs/',
    '*.md @writer',
    '^[Optional review]',
    '*.md @reviewers',
    '[docs]',
    'docs/api/ @api',
    '!secret.md @x',
  ].join('\r\n');
  const parsed = parseCodeowners(file);
  assert.deepEqual(parsed.sections.map((s) => [s.name, s.optional, s.approvals]), [[null, false, null], ['Docs', false, 2], ['Optional review', true, null]]);
  assert.deepEqual(parsed.problems, ["line 9: !secret.md (a ! pattern isn't supported, so it's left out)"]);
  // [docs] is the same section as [Docs], whose last matching line wins.
  assert.deepEqual(ownersOf(parsed, 'docs/api/x.md').owners, ['@admins', '@api', '@reviewers']);
  assert.deepEqual(ownersOf(parsed, 'docs/guide.txt').owners, ['@admins', '@docs-team'], "a line with none takes the section's owners");
  assert.deepEqual(ownersOf(parsed, 'src/a.js').owners, ['@admins']);
  assert.deepEqual(ownersOf(null, 'a').owners, [], 'no file, no owners');
  // A pattern can start with [ when it isn't a heading.
  assert.deepEqual(owners('[abc].js @x', '[abc].js'), ['@x']);
});

test('owners of several files, lines and texts, and reviewer names without yourself', () => {
  const parsed = parseCodeowners('* @ana\nsrc/ @ana @org/web\nREADME.md docs@example.com');
  const { owners: list, unowned } = ownersOfFiles(parsed, ['src/a.js', 'src/b.js', 'README.md', 'x']);
  assert.deepEqual(list, [
    { owner: '@ana', files: ['src/a.js', 'src/b.js', 'x'] },
    { owner: '@org/web', files: ['src/a.js', 'src/b.js'] },
    { owner: 'docs@example.com', files: ['README.md'] },
  ]);
  assert.deepEqual(unowned, []);
  assert.equal(ownersLine(['@a', '@b', '@c', '@d']), '@a @b @c +1');
  assert.equal(ownersLine([]), '');
  assert.deepEqual(reviewerNames(['@ana', '@org/web', 'docs@example.com', '@Ana'], 'ANA'), ['org/web']);
  assert.deepEqual(reviewerNames(['@ana', '@ana']), ['ana']);
  const one = ownersText('CODEOWNERS', parsed, 'src/a.js');
  assert.match(one, /@ana @org\/web\n {2}from CODEOWNERS:2 {2}src\//);
  assert.match(ownersText('CODEOWNERS', parseCodeowners('/a @x'), 'b'), /No line of CODEOWNERS matches it/);
  const many = changedOwnersText('CODEOWNERS', parseCodeowners('/a @x'), ['a', 'b']);
  assert.match(many, /@x {2}\(1\)\n {2}a\n\nNobody {2}\(1\)\n {2}b/);
});

let base;
let dir;
let origin;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'splice-owners-')));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.github'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @lead\nsrc/ @me @web-team\n');
  writeFileSync(join(dir, 'src', 'app.js'), 'one\n');
  writeFileSync(join(dir, 'notes.txt'), 'n\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // not yet
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
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

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

const flat = (s) => s.replace(/[│╭╮╰╯─\s]+/g, ' ');

test('the file is read again only once it changes', async () => {
  const first = await readCodeowners(dir);
  assert.equal(first.file, '.github/CODEOWNERS');
  assert.equal(await readCodeowners(dir), first, 'kept while it is as it was');
  writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @lead\nsrc/ @me @web-team\n# changed, and longer\n');
  const second = await readCodeowners(dir);
  assert.notEqual(second, first);
  assert.deepEqual(second.rules.map((r) => r.pattern), ['*', 'src/']);
  git('checkout', '--', '.github/CODEOWNERS');
});

test('owners in Changes, in blame, through /owners, and offered as the reviewers of a new pull request', async () => {
  const calls = [];
  const host = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    me: async () => 'me',
    list: async () => [],
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    defaultBranch: async () => 'main',
    create: async (opts) => {
      calls.push(['create', opts]);
      return 'https://example.invalid/pull/7\n';
    },
    addReviewers: async (pr, names) => calls.push(['reviewers', pr.id, names]),
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost: host }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    git('switch', '-q', '-c', 'feature');
    writeFileSync(join(dir, 'src', 'app.js'), 'one\ntwo\n');
    app.stdin.write('2');
    await until(() => /❯ M src\/app\.js\s+@me @web-team/.test(frame()), 'the owners beside the file');
    assert.match(flat(frame()), /src\/app\.js · @me @web-team/, "and in the diff's title");

    app.stdin.write('B');
    await until(() => frame().includes('Blame src/app.js · owners @me @web-team'), "blame's title");
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Blame src/app.js'), 'blame closed');

    await command(app, 'owners notes.txt');
    await until(() => frame().includes('Owners of notes.txt'), '/owners <path>');
    assert.match(flat(frame()), /@lead from \.github\/CODEOWNERS:1 \*/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Owners of notes.txt'), 'closed');
    await command(app, 'owners');
    await until(() => frame().includes('Owners of the changed files'), '/owners alone');
    assert.match(flat(frame()), /@me \(1\) src\/app\.js @web-team \(1\) src\/app\.js/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Owners of the changed files'), 'closed');

    writeFileSync(join(dir, 'notes.txt'), 'n\nm\n');
    git('commit', '-q', '-am', 'Two');
    git('push', '-q', '-u', 'origin', 'feature');
    await until(() => frame().includes('⎇ feature') && frame().includes('✓ clean'), 'the reload');
    await command(app, 'pr Two');
    await until(() => frame().includes('Open a pull request from feature into main?'), 'the question');
    app.stdin.write('1');
    await until(() => frame().includes('Ask the code owners to review #7?'), 'the owners offered');
    // Yourself left out; the others all picked.
    assert.doesNotMatch(frame(), /@me\b/);
    assert.match(frame(), /✓ @web-team/);
    assert.match(frame(), /✓ @lead/);
    // Drop the one under the cursor, then ask the other.
    const firstName = /❯ ✓ (@\S+)/.exec(frame())[1];
    app.stdin.write(' ');
    await until(() => frame().includes(`❯   ${firstName}`), 'one dropped');
    app.stdin.write('\r');
    await until(() => calls.some((c) => c[0] === 'reviewers'), 'the reviewers asked');
    const kept = ['web-team', 'lead'].filter((n) => `@${n}` !== firstName);
    assert.deepEqual(calls.find((c) => c[0] === 'reviewers'), ['reviewers', 7, kept]);
  } finally {
    app.unmount();
  }
});
