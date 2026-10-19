import { execFile } from 'node:child_process';

// Git runs without a terminal under the UI: it must never wait for a password
// prompt or an editor, and background reads shouldn't take the index lock.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_EDITOR: 'true',
};

export class GitError extends Error {
  constructor(message, { code = null, cancelled = false } = {}) {
    super(message);
    this.code = code;
    this.cancelled = cancelled;
  }
}

/**
 * Runs git in `cwd` and resolves with { stdout, stderr }. Rejects with a GitError carrying git's own message.
 * `input` is written to git's stdin (patches for `git apply -`).
 */
export function run(cwd, args, { signal, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, env: env ? { ...ENV, ...env } : ENV, maxBuffer: 256 * 1024 * 1024, windowsHide: true, signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        if (err.name === 'AbortError') return reject(new GitError('Cancelled', { cancelled: true }));
        const message = (stderr || stdout || err.message).trim();
        reject(new GitError(message, { code: typeof err.code === 'number' ? err.code : null }));
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

/** Runs git and resolves with stdout only. */
export async function git(cwd, args, opts) {
  return (await run(cwd, args, opts)).stdout;
}
