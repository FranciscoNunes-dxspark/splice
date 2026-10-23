// What Splice does with a context a sibling app copied (family.js's /take family:v1:…), and the lines it
// hands them. Pure: actions.js's `take` asks git and opens the pickers.
import { contextIn, decodeContext, matchFrameFile, stackFrames } from './family.js';

/** The app each kind of context Splice doesn't take is for, by name. */
export const CONTEXT_APPS = { request: 'Hail', rows: 'Trawl', query: 'Trawl', logline: 'Bosun' };

/** The kinds Splice takes. */
export const TAKES = ['exception', 'file', 'commit'];

/** The frames of an exception context, top first: its `frames`, else read from its `stack` text. */
export function exceptionFrames(data) {
  if (Array.isArray(data?.frames) && data.frames.length) return data.frames.filter((f) => f?.file);
  return stackFrames(data?.stack ?? data?.details ?? '');
}

/**
 * The frames that are files of the checkout (`files`: `git ls-files`, / separated), top first, each file
 * and line once: [{ path, line, method, file }] (`file` the frame's own path).
 */
export function framesInRepo(frames, files) {
  const out = [];
  const seen = new Set();
  for (const f of frames) {
    const path = matchFrameFile(f.file, files);
    if (!path) continue;
    const key = `${path}:${f.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, line: Number(f.line) || null, method: f.method ?? null, file: f.file });
  }
  return out;
}

/**
 * `/blame <path>:<line>` (or `<path>#L<line>`, as a link to a line reads): { path, line }; `line` null
 * when none was given. A Windows drive's colon isn't taken for one.
 */
export function pathAndLine(typed) {
  const s = String(typed ?? '').trim();
  const m = /^(.+?)(?::|#L)(\d+)(?::\d+)?$/.exec(s);
  if (m && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: Number(m[2]) };
  return { path: s, line: null };
}

/** What was typed after /take, or at the prompt: { kind, data }, or null when it isn't a context. */
export const takenContext = (text) => contextIn(text) ?? decodeContext(text);

/** The line saying a context is for another app: "That's an HTTP request: it's for Hail. Paste it into Hail's prompt." */
export function notForSplice(kind) {
  const app = CONTEXT_APPS[kind];
  const what = { request: 'an HTTP request', rows: 'some rows', query: 'a query', logline: 'a log line' }[kind] ?? `a ${kind}`;
  return app ? `That's ${what}: it's for ${app}. Paste it into ${app}'s prompt.` : `Splice doesn't take ${what}.`;
}
