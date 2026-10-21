// Signed commits: what `git log %G?` says about a signature, and signing without a terminal. Git runs
// with no terminal under Splice, so a signing key's passphrase can't be typed into one: a pinentry that
// needs a terminal must fail at once with a clear message, never sit waiting or draw over the UI.
import { execFile } from 'node:child_process';

/** What `%G?` means, as { text, tone } for the commit pane; `signer` is `%GS`. */
export function signatureText(code, signer = '') {
  const by = signer ? ` by ${signer}` : '';
  switch (code) {
    case 'G':
      return { text: `Good signature${by}`, tone: 'good' };
    case 'U':
      return { text: `Good signature${by}, from a key you haven't marked as trusted`, tone: 'good' };
    case 'X':
      return { text: `Good signature${by}, now expired`, tone: 'wait' };
    case 'Y':
      return { text: `Good signature${by}, made with a key that has expired`, tone: 'wait' };
    case 'R':
      return { text: `Signed${by} with a key that has been revoked`, tone: 'bad' };
    case 'B':
      return { text: `Bad signature${by}: the commit doesn't match it`, tone: 'bad' };
    case 'E':
      return { text: "Signed, but the signature can't be checked here (missing key or tool)", tone: 'wait' };
    default:
      return { text: 'Not signed', tone: 'none' };
  }
}

/**
 * Reads `git config --get-regexp` output for the signing settings: whether commits (and tags) are signed,
 * the format (openpgp, ssh or x509), the key, and the program git signs with.
 */
export function signingConfig(raw) {
  const out = { commits: false, tags: false, format: 'openpgp', key: null, program: null };
  for (const line of (raw ?? '').split('\n')) {
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const val = sp < 0 ? 'true' : line.slice(sp + 1).trim();
    const on = /^(true|yes|on|1)$/i.test(val);
    if (key === 'commit.gpgsign') out.commits = on;
    else if (key === 'tag.gpgsign') out.tags = on;
    else if (key === 'gpg.format') out.format = val.toLowerCase();
    else if (key === 'user.signingkey') out.key = val;
    else if (key === 'gpg.program' || key === 'gpg.openpgp.program') out.program = val;
  }
  return out;
}

export const SIGNING_KEYS = '^(commit\\.gpgsign|tag\\.gpgsign|gpg\\.format|user\\.signingkey|gpg\\.program|gpg\\.openpgp\\.program)$';

/**
 * Whether an OpenPGP key must be checked before signing: on Linux and the BSDs without a graphical session,
 * the only pinentry there could be is one that needs a terminal, which Splice's git doesn't have. (Windows and
 * macOS, and desktops with a display, have a pinentry that opens its own window.)
 */
export function needsPinentryCheck(cfg, { platform = process.platform, env = process.env } = {}) {
  if (!cfg.commits || cfg.format !== 'openpgp') return false;
  if (platform === 'win32' || platform === 'darwin') return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** A clear message for a signing failure in git's output, or null when the error is about something else. */
export function explainSigning(message) {
  const m = message ?? '';
  if (!/gpg failed to sign|failed to sign the data|signing failed|ssh-keygen|error: (?:gpg|ssh) |No pinentry|Inappropriate ioctl|failed to write commit object.*sign/i.test(m)) return null;
  const ssh = /ssh-keygen|ssh/i.test(m) && !/gpg/i.test(m);
  return [
    `Signing failed: ${ssh ? 'ssh-keygen' : 'gpg'} couldn't sign the commit, and Splice has no terminal to ask for the key's passphrase in.`,
    ssh
      ? 'Add the key to your ssh-agent first (ssh-add), then try again.'
      : 'Unlock the key once in a terminal first (for example: echo test | gpg --clearsign > /dev/null), or use a pinentry that opens its own window, then try again.',
    'To commit without signing, turn commit.gpgsign off: !config commit.gpgsign false',
  ].join('\n');
}

/**
 * Signs a few bytes with gpg, never asking for a passphrase (--pinentry-mode error): resolves when the key is
 * ready to use, rejects with gpg's message when it's locked (or missing). Only for needsPinentryCheck.
 */
export function checkGpgKey(cfg, { cwd } = {}) {
  const args = ['--batch', '--no-tty', '--pinentry-mode', 'error', '--sign', '--armor', '--output', '-', ...(cfg.key ? ['--local-user', cfg.key] : [])];
  return new Promise((resolve, reject) => {
    const child = execFile(cfg.program || 'gpg', args, { cwd, windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, _out, stderr) => {
      if (!err) return resolve();
      reject(new Error((stderr || err.message).trim()));
    });
    // gpg may stop before reading anything (no key, say): that's its answer, not an error of ours.
    child.stdin.on('error', () => {});
    child.stdin.end('splice\n');
  });
}
