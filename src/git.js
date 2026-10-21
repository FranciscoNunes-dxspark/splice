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
 * started as well (the command `git bisect run` tests with), not git alone. `codes`: exit codes other
 * than 0 that aren't failures (merge-tree's 1 for "it would conflict"); the result then carries the `code`.
 */
export function run(cwd, args, { signal, input, env, tree = false, codes = [] } = {}) {
  const all = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
  return spawnGit(cwd, all, { signal, input, env: env ? { ...ENV, ...env } : ENV, tree, codes });
}

// spawn rather than execFile, which doesn't pass `detached` on. Started detached, git also leads a
// process group of its own, which what it runs is in too, so with `tree` cancelling can stop the lot.
function spawnGit(cwd, args, { signal, input, env, tree, codes }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true, detached: DETACH });
    const out = [];
    const err = [];
    child.stdout.setEncoding('utf8').on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => err.push(d));
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (!tree) child.kill();
      else if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
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
      if (code === 0 || codes.includes(code)) return resolve({ stdout, stderr, code });
      reject(failure(stdout, stderr, `git exited with ${code}`, code));
    });
    // Nothing waits on stdin: git gets the input, or an end of it at once.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/** Runs git and resolves with stdout only. */
export async function git(cwd, args, opts) {
  return (await run(cwd, args, opts)).stdout;
}
