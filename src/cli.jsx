import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './version.js';
import { loadConfig } from './config.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';
import { checkForUpdate } from './update.js';
import { ask } from './claude.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`tiller ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`tiller [path]

A keyboard-driven git client. Opens the repository at [path] (default: the
current folder). If that isn't a repository, it lists the ones it finds there;
with no [path], it opens the repository you had open last instead.

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
// The window title is saved on the terminal's title stack and popped on exit. Terminals without one
// (Windows Terminal) take an empty title as "back to the default" instead.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates: a checkout updates with git pull, and its
// package.json version is behind the releases (the Release workflow sets the version as it builds).
const checkUpdate = COMPILED ? checkForUpdate : undefined;
const path = args.find((x) => !x.startsWith('-'));
// Started without a path outside a repository, Tiller reopens the last one; a path given means look there.
const app = render(<App initialPath={resolve(path ?? process.cwd())} reopenLast={!path} config={config} checkUpdate={checkUpdate} askClaude={ask} setTitle={setTitle} />, {
  exitOnCtrlC: false,
});
await app.waitUntilExit();
process.exit(0);
