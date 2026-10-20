import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './version.js';
import { loadConfig } from './config.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';
import { checkForUpdate, installUpdate, removeOldExecutables } from './update.js';
import { ask } from './claude.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`tiller ${VERSION}`);
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

// Only the downloaded executables look for updates and install them: a checkout updates with git pull,
// and its package.json version is behind the releases (the Release workflow sets the version as it builds).
const checkUpdate = COMPILED ? checkForUpdate : undefined;
// What an earlier update moved aside; quietly, and it doesn't hold up the start.
if (COMPILED) removeOldExecutables();
const app = render(
  <App
    initialPath={resolve(args.find((x) => !x.startsWith('-')) ?? process.cwd())}
    config={config}
    checkUpdate={checkUpdate}
    installUpdate={COMPILED ? installUpdate : undefined}
    askClaude={ask}
  />,
  { exitOnCtrlC: false },
);
await app.waitUntilExit();
process.exit(0);
