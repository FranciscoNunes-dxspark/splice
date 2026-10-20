import { theme } from './theme.js';
import { clean, stringWidth } from './text.js';

// Escapes, `code`, images, [links](url), <autolinks>, HTML tags (dropped), **bold**, ~~strike~~, *italic*, _italic_.
const INLINE =
  /\\(?<esc>[!-\/:-@\[-`{-~])|(?<tick>`+)(?<code>[\s\S]+?)\k<tick>|!\[(?<alt>[^\]]*)\]\([^)]*\)|\[(?<link>[^\]]+)\]\(\s*<?(?<url>[^)\s>]*)>?[^)]*\)|<(?<auto>https?:\/\/[^>\s]+)>|<\/?[A-Za-z][^>]*>|(?<bm>\*\*|__)(?=\S)(?<bold>[\s\S]*?\S)\k<bm>|~~(?=\S)(?<strike>[\s\S]*?\S)~~|\*(?=[^\s*])(?<em>[\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])(?<em2>[\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

/** One line of Markdown text as styled segments. */
function inline(s, style = {}) {
  const out = [];
  const push = (text, st = style) => text && out.push({ ...st, text });
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    push(s.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m.groups;
    if (g.esc) push(g.esc);
    else if (g.code) push(g.code.replace(/^ (.*) $/, '$1'), { ...style, color: theme.hunk });
    else if (g.alt !== undefined) push(`[image${g.alt ? `: ${g.alt}` : ''}]`, { ...style, color: theme.dim });
    else if (g.link) {
      out.push(...inline(g.link, { ...style, color: theme.local }));
      if (g.url && g.url !== g.link && !g.url.startsWith('#')) push(` (${g.url})`, { ...style, color: theme.dim });
    } else if (g.auto) push(g.auto, { ...style, color: theme.local });
    else if (g.bold) out.push(...inline(g.bold, { ...style, bold: true }));
    else if (g.strike) out.push(...inline(g.strike, { ...style, dim: true }));
    else if (g.em || g.em2) out.push(...inline(g.em || g.em2, { ...style, italic: true }));
  }
  push(s.slice(last));
  return out;
}

const widthOf = (segs) => segs.reduce((n, s) => n + stringWidth(s.text), 0);

/** Word-wraps styled segments to `width`, starting with `first` and continuing each later line with `rest`. */
function wrapSegments(segs, width, first = [], rest = first) {
  const lines = [];
  let line = [...first];
  let used = widthOf(first);
  let fresh = true;
  let space = null;
  const next = () => {
    lines.push(line);
    line = [...rest];
    used = widthOf(rest);
    fresh = true;
    space = null;
  };
  for (const seg of segs) {
    for (const part of clean(seg.text).split(/( +)/)) {
      if (!part) continue;
      if (part[0] === ' ') {
        if (!fresh) space = { ...seg, text: ' ' };
        continue;
      }
      let word = part;
      let w = stringWidth(word);
      if (!fresh && used + (space ? 1 : 0) + w > width) next();
      if (space) {
        line.push(space);
        used += 1;
        space = null;
      }
      // A word wider than the whole line (a long URL) is cut across lines rather than lost off the edge.
      while (fresh && used + w > width) {
        let head = '';
        for (const ch of word) {
          if (used + stringWidth(head + ch) > width) break;
          head += ch;
        }
        if (!head) break;
        line.push({ ...seg, text: head });
        word = word.slice(head.length);
        w = stringWidth(word);
        next();
      }
      if (word) {
        line.push({ ...seg, text: word });
        used += w;
        fresh = false;
      }
    }
  }
  if (!fresh || !lines.length) lines.push(line);
  return lines;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => inline(c.trim().replace(/\\\|/g, '|')));

function table(rows) {
  const [head, ...body] = rows.map(cells);
  const n = Math.max(...[head, ...body].map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(...[head, ...body].map((r) => widthOf(r[i] ?? []))));
  const sep = { text: ' │ ', color: theme.border };
  const line = (row, style) =>
    widths.flatMap((w, i) => {
      const c = (row[i] ?? []).map((s) => ({ ...s, ...style }));
      return [...(i ? [sep] : []), ...c, { text: ' '.repeat(w - widthOf(c)) }];
    });
  const rule = [{ text: widths.map((w) => '─'.repeat(w)).join('─┼─'), color: theme.border }];
  // Wider than the pane, rows are cut at the edge like any other line: wrapping a row breaks the columns.
  return [line(head, { bold: true }), rule, ...body.map((r) => line(r))];
}

/**
 * Markdown as styled lines for the terminal, each an array of segments ({ text, color, bold, italic, dim })
 * word-wrapped to `width`. Covers what pull request descriptions and Claude's answers use: headings, emphasis,
 * `code` and code blocks, lists and task lists, quotes, links, rules and tables. Line breaks are kept, as on
 * GitHub's comments. HTML comments (pull request templates are full of them) and tags are dropped.
 */
export function renderMarkdown(text, width) {
  const lines = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .split('\n');
  const out = [];
  const add = (...ls) => out.push(...ls);
  const gap = () => out.length && out.at(-1).length && out.push([]);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      if (l.trim().startsWith(fence) && !l.trim().slice(fence.length).trim()) fence = null;
      else add([{ text: `  ${clean(l)}`, color: theme.hunk }]);
      continue;
    }
    let m;
    if ((m = FENCE.exec(l))) {
      fence = m[1];
      continue;
    }
    if (l.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      const rows = [l];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(lines[i]);
      i--;
      add(...table(rows));
    } else if (!l.trim()) {
      gap();
    } else if ((m = HEADING.exec(l))) {
      gap();
      add(...wrapSegments(inline(m[2], { bold: true, color: m[1].length <= 2 ? theme.accent : undefined }), width));
    } else if (RULE.test(l)) {
      add([{ text: '─'.repeat(Math.max(0, width)), color: theme.border }]);
    } else if ((m = QUOTE.exec(l))) {
      const bar = [{ text: '│ ', color: theme.border }];
      add(...wrapSegments(inline(m[1], { color: theme.dim, italic: true }), width, bar));
    } else if ((m = ITEM.exec(l))) {
      const indent = '  '.repeat(Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2)));
      let body = m[3];
      let marker = /\d/.test(m[2]) ? { text: `${m[2]} ` } : { text: '• ', color: theme.dim };
      const task = TASK.exec(body);
      if (task) {
        body = body.slice(task[0].length);
        marker = task[1] === ' ' ? { text: '○ ', color: theme.dim } : { text: '✓ ', color: theme.add };
      }
      const first = [{ text: indent }, marker];
      add(...wrapSegments(inline(body), width, first, [{ text: ' '.repeat(widthOf(first)) }]));
    } else {
      const lead = /^\s*/.exec(l)[0].replace(/\t/g, '    ').slice(0, 8);
      const first = lead ? [{ text: lead }] : [];
      add(...wrapSegments(inline(l.trim().replace(/(\\|\s{2,})$/, '')), width, first));
    }
  }
  while (out.length && !out.at(-1).length) out.pop();
  while (out.length && !out[0].length) out.shift();
  return out;
}
