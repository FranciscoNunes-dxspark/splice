import React from 'react';
import { render } from 'ink';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  // The compiled builds have it baked in; from a checkout, read it from package.json.
  const version =
    process.env.TILLER_VERSION ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  console.log(`tiller ${version}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`tiller [path]

A keyboard-driven git client. Opens the repository at [path] (default: the
current folder). If that isn't a repository, it lists the ones it finds there.

Inside: press ? for shortcuts, / for commands, ! to run any git command.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('tiller needs an interactive terminal.');
  process.exit(1);
}

const config = loadConfig();
setAccent(config.accent);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

const app = render(<App initialPath={resolve(args.find((x) => !x.startsWith('-')) ?? process.cwd())} config={config} />, {
  exitOnCtrlC: false,
});
await app.waitUntilExit();
process.exit(0);
