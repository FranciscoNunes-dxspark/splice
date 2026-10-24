// The family's activity log and the wiring view, through the UI against a throwaway repository: what Splice
// adds to the log as it pushes, merges, deletes, resets, discards, syncs and pushes a tag (and never a diff's
// content), /timeline over all five apps or this repository alone, and /wiring by file with secrets masked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { logActivity, readActivity } from '../src/family.js';
import { App } from '../src/ui/App.jsx';

let base;
let dir;
let origin;
let home;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'splice-timeline-')));
  dir = join(base, 'shop');
  origin = join(base, 'origin.git');
  home = join(base, 'family');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Default: 'Server=db.internal;Database=shop;User Id=app;Password=hunter2;' }, Logging: { LogLevel: { Default: 'Information' } } }));
  writeFileSync(join(dir, '.env'), 'API_URL=https://api.example.com\nPORT=5000\nAPI_KEY=abc123\nNAME=shop\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  git('switch', '-q', '-c', 'topic');
  writeFileSync(join(dir, 'topic.txt'), 'topic\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Topic work');
  git('switch', '-q', 'main');
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

const logged = () => readActivity({ dir: home }).filter((e) => e.app === 'splice').map((e) => e.text);
const hasLogged = (text) => logged().includes(`${text} (shop)`);

test('Splice logs what it did for the family; /timeline shows it all or this repository; /wiring by file', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, familyHome: home }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    writeFileSync(join(dir, 'b.txt'), 'SECRET CONTENT\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Second commit');
    await until(() => frame().includes('↑1'), 'one commit to push');
    await command(app, 'push');
    await until(() => hasLogged('pushed main to origin (1 commit)'), 'the push logged');

    await command(app, 'merge topic');
    await until(() => hasLogged('merged topic into main'), 'the merge logged');
    await command(app, 'delete topic');
    await until(() => hasLogged('deleted the branch topic'), 'the deletion logged');

    await command(app, 'reset HEAD~1');
    await until(() => frame().includes('Reset main to HEAD~1?'), 'the reset question');
    app.stdin.write('1');
    await until(() => hasLogged('reset main to HEAD~1 (soft)'), 'the reset logged');
    await until(() => frame().includes('change'), 'the changes it left');
    await command(app, 'discard');
    await until(() => frame().includes('Discard all changes to'), 'the discard question');
    app.stdin.write('1');
    await until(() => logged().some((t) => /^discarded the changes to \d+ files? \(shop\)$/.test(t)), 'the discard logged');

    await command(app, 'sync');
    await until(() => logged().some((t) => t.startsWith('synced: ')) && frame().includes('Fetched every remote'), 'the sync logged, and its report');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Fetched every remote'), 'the report closed');
    await command(app, 'tag v1');
    await until(() => git('tag') === 'v1', 'the tag');
    await command(app, 'tag-push v1');
    await until(() => hasLogged('pushed the tag v1 to origin'), 'the tag push logged');

    const raw = readFileSync(join(home, 'activity.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /SECRET CONTENT/, 'nothing from a diff');
    const same = (a, b) => (process.platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b);
    for (const e of readActivity({ dir: home })) assert.ok(same(e.project, dir), `each with the repository it was in: ${e.project}`);

    // Another app's entries: one in another project, one naming none.
    logActivity('bosun', { text: 'restarted api', kind: 'restart', project: join(base, 'elsewhere') }, { dir: home });
    logActivity('hail', { text: 'ran a load test', kind: 'load' }, { dir: home, now: Date.now() - 2 * 3600_000 });
    logActivity('trawl', { text: 'ran an UPDATE on orders (3 rows)', kind: 'write' }, { dir: home });

    await command(app, 'timeline');
    await until(() => frame().includes('Timeline: the family') && frame().includes('restarted api'), 'the timeline');
    assert.match(frame(), /❯ +now +Trawl +ran an UPDATE on orders \(3 rows\)/, 'newest first, and just now');
    assert.match(frame(), /Bosun +restarted api +elsewhere/);
    assert.match(frame(), / 2h +Hail +ran a load test/, 'an older entry says how long ago');
    assert.match(frame(), /Splice +pushed the tag v1 to origin \(shop\)/);
    app.stdin.write('p');
    await until(() => frame().includes('Timeline of shop'), 'this repository only');
    assert.doesNotMatch(frame(), /restarted api/, "another project's entry left out");
    assert.match(frame(), /ran an UPDATE on orders/, 'one naming no project stays');
    app.stdin.write('\r');
    await until(() => frame().includes('Kind: write'), 'the whole entry');
    app.stdin.write('\x1b');
    await until(() => frame().includes('Timeline of shop'), 'back to the list');
    app.stdin.write('p');
    await until(() => frame().includes('Timeline: the family'), 'everything again');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Timeline'), 'closed');

    await command(app, 'wiring');
    await until(() => frame().includes('What shop points at'), '/wiring');
    const text = frame().replace(/[│\s]+/g, ' ');
    assert.match(text, /appsettings\.json ConnectionStrings:Default Server=db\.internal;Database=shop;User Id=app;Password=••••;/);
    assert.match(text, /\.env API_URL +https:\/\/api\.example\.com PORT +5000/);
    assert.doesNotMatch(text, /hunter2|abc123/, 'secrets masked');
    assert.doesNotMatch(text, /LogLevel|NAME/, 'only what points somewhere');
  } finally {
    app.unmount();
  }
});

test('without the family folder, nothing is logged', async () => {
  const other = join(base, 'family-none');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    await command(app, 'tag v2');
    await until(() => git('tag').includes('v2'), 'the tag');
    await command(app, 'tag-push v2');
    await until(() => run(origin, 'tag').includes('v2'), 'pushed');
    assert.equal(logged().filter((t) => t.includes('v2')).length, 0);
    assert.deepEqual(readActivity({ dir: other }), []);
  } finally {
    app.unmount();
  }
});
