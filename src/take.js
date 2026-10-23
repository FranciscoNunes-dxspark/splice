// What Splice does with a context a sibling app copied (family.js's /take family:v1:…), and the lines it
// hands them. Pure: actions.js's `take` asks git and opens the pickers.
import { TAKEN_BY, matchFrameFile, stackFrames } from './family.js';

/** The kinds Splice takes (family.js's TAKEN_BY says the same). */
export const TAKES = Object.keys(TAKEN_BY).filter((k) => TAKEN_BY[k].includes('splice'));

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
