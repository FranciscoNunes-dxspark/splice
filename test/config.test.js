import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './temp.js';
import { loadConfig, saveConfig } from '../src/config.js';

test("settings from when Splice was called Tiller carry over, and the old file is left alone", async () => {
  const home = mkdtempSync(join(tmpdir(), 'splice-config-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SPLICE_HOME: process.env.SPLICE_HOME };
  // os.homedir() reads these, so the real home folder is never touched.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SPLICE_HOME;
  try {
    assert.deepEqual(loadConfig().recent, []);

    mkdirSync(join(home, '.tiller'));
    const old = JSON.stringify({ recent: ['C:\\repo'], accent: '#ff8800' });
    writeFileSync(join(home, '.tiller', 'config.json'), old);
    const config = loadConfig();
    assert.deepEqual(config.recent, ['C:\\repo']);
    assert.equal(config.accent, '#ff8800');
    assert.deepEqual(config.history, []);

    // Saving writes Splice's own file; from then on that's what's read.
    saveConfig({ ...config, accent: '#00aaff' });
    assert.equal(JSON.parse(readFileSync(join(home, '.splice', 'config.json'), 'utf8')).accent, '#00aaff');
    assert.equal(loadConfig().accent, '#00aaff');
    assert.equal(readFileSync(join(home, '.tiller', 'config.json'), 'utf8'), old);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await removeTemp(home);
  }
});
