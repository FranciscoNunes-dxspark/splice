// Splice in its family: what a repository offers the sibling apps (/family), a pasted command line or
// context opening the prompt, and Twig's mood told to the others and theirs read back. The pure parts,
// then through the real UI against a throwaway repository and a family folder of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { encodeContext, projectAt, takeLine, writeMood } from '../src/family.js';
import { familyMood, familyOffers, moodsToShow, reactionText, trawlName } from '../src/siblings.js';
import { App } from '../src/ui/App.jsx';

test("Trawl's name for a database: its settings' key, the database's for an environment variable's", () => {
  assert.equal(trawlName({ name: 'Shop', database: 'Shop' }, 'repo'), 'Shop');
  assert.equal(trawlName({ name: 'DATABASE_URL', database: 'orders' }, 'repo'), 'orders');
  assert.equal(trawlName({ name: 'DATABASE_URL' }, 'repo'), 'repo');
});

test("Twig's mood as the family says it, and the others' worth a word", () => {
  const data = { name: 'shop', state: null, changes: { conflicts: [{}, {}, {}] }, status: { branch: { ahead: 2 } } };
  assert.deepEqual(familyMood('worried', { data }), { mood: 'worried', reason: '3 conflicts in shop' });
  assert.deepEqual(familyMood('worried', { data: { ...data, changes: { conflicts: [] } }, lastEntry: { title: 'git push' } }), { mood: 'worried', reason: 'git push failed' });
  assert.deepEqual(familyMood('happy', { lastEntry: { title: 'git push' } }), { mood: 'happy', reason: 'git push went through' });
  assert.deepEqual(familyMood('look', { busy: { label: 'Fetching' } }), { mood: 'busy', reason: 'Fetching' });
  assert.deepEqual(familyMood('wave', { data }), { mood: 'neutral', reason: '2 commits to push' });
  const moods = [{ app: 'sonar', mood: 'worried', reason: 'production has 12 new exceptions', at: 2 }, { app: 'bosun', mood: 'busy', at: 1 }, { app: 'hail', mood: 'happy', reason: '', at: 3 }];
  assert.deepEqual(moodsToShow(moods, new Set(['hail:3'])).map((m) => m.app), ['sonar']);
  assert.equal(reactionText(moods[0]), 'Ping says: production has 12 new exceptions');
  assert.equal(reactionText(moods[2]), 'Hoot looks happy');
});

let base;
let dir;
let home;
let lastApp = null;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-family-'));
  dir = join(base, 'shop');
  home = join(base, 'family');
  mkdirSync(join(dir, 'api'), { recursive: true });
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"node server.js"}}\n');
  writeFileSync(join(dir, 'api', 'orders.http'), 'GET http://localhost/orders\n');
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Shop: 'Server=tcp:shop.database.windows.net,1433;Database=Shop;Authentication=Active Directory Default' } }));
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://me:hunter2@db.local:5432/orders\n');
  git('add', '.');
  git('commit', '-q', '-m', 'The shop');
});

after(() => removeTemp(base));

test('what a repository offers the others', () => {
  const offers = familyOffers(projectAt(dir), 'shop');
  assert.deepEqual(offers.map((o) => [o.app, o.line]), [
    ['bosun', `/move ${dir}`],
    ['hail', `/open ${join(dir, 'api', 'orders.http')}`],
    ['trawl', '/azure-sql shop.database.windows.net Shop'],
    ['trawl', '/add orders db.local:5432 orders --kind postgres --user me'],
  ]);
  assert.ok(!offers.some((o) => o.line.includes('hunter2')));
});

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

const flat = (s) => s.replace(/\s+/g, ' ');
const prompt = (frame) => /│ > (.*?) *│/.exec(frame)?.[1] ?? '';

test('a paste opens the prompt; /family copies a line; a sibling\'s mood gets a word from Twig, and Twig\'s is written', async () => {
  writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' }, { dir: home });
  const copied = [];
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, copy: (t) => copied.push(t), familyHome: home }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('The shop'), 'the graph');
    await until(() => frame().includes('Ping says: production has 12 new exceptions'), "Ping's mood");
    await until(() => JSON.parse(readFileSync(join(home, 'splice.mood.json'), 'utf8')).reason === 'everything committed', "Twig's mood written");
    assert.equal(JSON.parse(readFileSync(join(home, 'splice.mood.json'), 'utf8')).mood, 'neutral');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Ping says'), 'put away');

    // Pasted in the graph: into the prompt, not run, and not taken as keys for the view.
    app.stdin.write('/family\r');
    await until(() => prompt(frame()) === '/family', 'the line in the prompt');
    assert.doesNotMatch(frame(), /What shop offers/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('enter run'), 'back in the view');
    const ctx = encodeContext('commit', { hash: git('rev-parse', 'HEAD') });
    app.stdin.write(`${ctx}\n`);
    await until(() => prompt(frame()).startsWith('family:v1:commit:'), 'the context in the prompt');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('enter run'), 'back in the view again');

    // Over the viewer (a diff), the same; a / typed alone there still searches.
    app.stdin.write('\r');
    await until(() => frame().includes('package.json'), 'the diff');
    app.stdin.write(takeLine('file', { path: 'package.json' }));
    await until(() => prompt(frame()).startsWith('/take family:v1:file:'), 'the /take line in the prompt');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('enter run'), 'the prompt left');
    app.stdin.write('/');
    await until(() => frame().includes('/▏'), 'searching');
    app.stdin.write('/take');
    await until(() => frame().includes('//take▏'), "the paste is the search's");
    assert.doesNotMatch(frame(), /enter run/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('//take▏'), 'the search cancelled');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('package.json |'), 'the viewer closed');

    app.stdin.write('/');
    await until(() => frame().includes('> /'), 'the prompt');
    app.stdin.write('family');
    await until(() => frame().includes('> /family'), 'typed');
    app.stdin.write('\r');
    await until(() => frame().includes('What shop offers the other apps'), 'the list');
    assert.match(frame(), /Bosun\s+\/move /);
    assert.match(frame(), /Hail\s+\/open .*orders\.http/);
    assert.match(frame(), /Trawl\s+\/azure-sql shop\.database\.windows\.net Shop/);
    assert.match(frame(), /Trawl\s+\/add orders db\.local:5432 orders --kind postgres --user me/);
    app.stdin.write('\r');
    await until(() => copied.length === 1, 'copied');
    assert.equal(copied[0], `/move ${dir}`);
    assert.match(flat(frame()), /Copied for Bosun: paste it into Bosun's prompt/);
  } finally {
    app.unmount();
  }
});
