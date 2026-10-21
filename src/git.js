import { execFile } from 'node:child_process';
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

/**
 * Runs git in `cwd` and resolves with { stdout, stderr }. Rejects with a GitError carrying git's own message.
 * `input` is written to git's stdin (patches for `git apply -`). `codes`: exit codes other than 0 that aren't
 * failures (merge-tree's 1 for "it would conflict"); the result then carries the `code`.
 */
export function run(cwd, args, { signal, input, env, codes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, env: env ? { ...ENV, ...env } : ENV, maxBuffer: 256 * 1024 * 1024, windowsHide: true, detached: DETACH, signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        if (codes.includes(err.code)) return resolve({ stdout, stderr, code: err.code });
        if (err.name === 'AbortError') return reject(new GitError('Cancelled', { cancelled: true }));
        const message = (stderr || stdout || err.message).trim();
        // A commit that couldn't be signed says why, and what to do, before git's own words.
        const signing = explainSigning(message);
        reject(new GitError(signing ? `${signing}\n\n${message}` : message, { code: typeof err.code === 'number' ? err.code : null }));
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

/** Runs git and resolves with stdout only. */
export async function git(cwd, args, opts) {
  return (await run(cwd, args, opts)).stdout;
}
