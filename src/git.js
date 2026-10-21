import { execFile, spawn } from 'node:child_process';
import { explainSigning } from './signing.js';

// Git runs without a terminal under the UI: it must never wait for a password
// prompt or an editor, and background reads shouldn't take the index lock.
// GPG_TTY is left out so gpg can't send a passphrase prompt to Splice's terminal either.
const { GPG_TTY: _tty, ...inherited } = process.env;
const ENV = {
  ...inherited,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_EDITOR: 'true',
};

// Off Windows, git starts in a session of its own, without a controlling terminal: what it runs (ssh asking
// about a host key or a passphrase, ssh-keygen signing, a pinentry) can't open the terminal Splice draws on,
// so it fails at once instead of waiting there for an answer that can't be typed.
const DETACH = process.platform !== 'win32';

export class GitError extends Error {
  constructor(message, { code = null, cancelled = false } = {}) {
    super(message);
    this.code = code;
    this.cancelled = cancelled;
  }
}

function failure(stdout, stderr, fallback, code) {
  const message = (stderr || stdout || fallback).trim();
  // A commit that couldn't be signed says why, and what to do, before git's own words.
  const signing = explainSigning(message);
  return new GitError(signing ? `${signing}\n\n${message}` : message, { code: typeof code === 'number' ? code : null });
}

/**
 * Runs git in `cwd` and resolves with { stdout, stderr }. Rejects with a GitError carrying git's own message.
 * `input` is written to git's stdin (patches for `git apply -`). With `tree`, cancelling stops what git
 * started as well (the command `git bisect run` tests with), not git alone.
 */
export function run(cwd, args, { signal, input, env, tree = false } = {}) {
  const all = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
  const fullEnv = env ? { ...ENV, ...env } : ENV;
  if (tree) return runTree(cwd, all, { signal, input, env: fullEnv });
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      all,
      { cwd, env: fullEnv, maxBuffer: 256 * 1024 * 1024, windowsHide: true, detached: DETACH, signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        if (err.name === 'AbortError') return reject(new GitError('Cancelled', { cancelled: true }));
        reject(failure(stdout, stderr, err.message, err.code));
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

// spawn rather than execFile, which doesn't pass `detached` on: started detached, git leads a process
// group of its own, which what it runs is in too, so cancelling can stop the lot.
function runTree(cwd, args, { signal, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true, detached: DETACH });
    const out = [];
    const err = [];
    child.stdout.setEncoding('utf8').on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => err.push(d));
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', stop);
      reject(new GitError(e.message));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      const stdout = out.join('');
      const stderr = err.join('');
      if (stopped) return reject(new GitError('Cancelled', { cancelled: true }));
      if (code === 0) return resolve({ stdout, stderr });
      reject(failure(stdout, stderr, `git exited with ${code}`, code));
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
  });
}

/** Runs git and resolves with stdout only. */
export async function git(cwd, args, opts) {
  return (await run(cwd, args, opts)).stdout;
}
