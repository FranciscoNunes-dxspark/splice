// CODEOWNERS: who owns which files, as GitHub and GitLab read the file. Pure: repo.js reads the file
// (again only when it changes) and hands its text here.
//
// GitHub: `pattern owner…` lines, # comments, gitignore-style patterns (anchored by a / at the start or in
// the middle; `*` stops at a /, `**` doesn't; a trailing / is a folder's contents; `docs/*` is only the
// files right in docs), and the last line that matches a file wins. A pattern with no owners leaves the
// file without any. GitLab adds sections, `[Name]` (optional with ^, `[Name][2]` for the approvals
// needed, and owners after the heading that every pattern in the section without its own gets): the last
// match wins within each section, and a file's owners are those of every section. Azure DevOps has no
// CODEOWNERS file (it sets reviewers by branch policy), so nothing here is asked of it.

/** Where the file is looked for, in GitHub's order (GitLab's own folder last); the first that exists is the one. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];

// A line's words: split on unescaped spaces, with `\ ` and `\#` kept as the characters.
function words(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += `\\${line[++i]}`;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else if (ch === '#' && !cur) {
      // A comment after the owners (an owner never starts with #).
      break;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const SECTION = /^(\^)?\[([^\]]+)\](?:\[(\d+)\])?(.*)$/;

/**
 * The file's rules: { rules: [{ pattern, owners, section, line }], sections: [{ name, optional, approvals,
 * owners }], problems: [string] }. GitHub's file has one unnamed section (name null).
 */
export function parseCodeowners(text) {
  const rules = [];
  const problems = [];
  const sections = [{ name: null, optional: false, approvals: null, owners: [] }];
  let section = sections[0];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const s = SECTION.exec(line);
      // A section heading: [Name], ^[Name], [Name][2], each perhaps with default owners after it. A
      // pattern can start with [ too ([abc].js), but not with a heading's shape and nothing but owners after.
      if (s && (!s[4].trim() || /^\s/.test(s[4]))) {
        const name = s[2].trim();
        section = sections.find((x) => x.name?.toLowerCase() === name.toLowerCase());
        if (!section) {
          section = { name, optional: Boolean(s[1]), approvals: s[3] ? Number(s[3]) : null, owners: words(s[4]) };
          sections.push(section);
        }
        return;
      }
      const [pattern, ...owners] = words(line);
      if (pattern.startsWith('!')) {
        problems.push(`line ${i + 1}: ${pattern} (a ! pattern isn't supported, so it's left out)`);
        return;
      }
      rules.push({ pattern, owners, section: section.name, line: i + 1, re: patternRegex(pattern) });
    });
  return { rules, sections, problems };
}

const escape = (ch) => (/[.+^${}()|[\]\\/?*]/.test(ch) ? `\\${ch}` : ch);

/** A CODEOWNERS pattern as a RegExp over a path relative to the repository's root, with forward slashes. */
export function patternRegex(pattern) {
  let p = pattern;
  const folder = p.endsWith('/') && p.length > 1;
  if (folder) p = p.replace(/\/+$/, '');
  // A / at the start or in the middle ties it to the root; otherwise it matches at any depth.
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) body += escape(p[++i]);
    else if (ch === '*' && p[i + 1] === '*') {
      const before = i === 0 || p[i - 1] === '/';
      const after = p[i + 2] === '/' || i + 2 === p.length;
      if (before && p[i + 2] === '/') {
        // **/ : any folders, or none.
        body += '(?:.*/)?';
        i += 2;
      } else if (before && after) {
        body += '.*';
        i += 1;
      } else {
        body += '[^/]*';
        i += 1;
      }
    } else if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else body += escape(ch);
  }
  const last = p.slice(p.lastIndexOf('/') + 1);
  // What's under a match counts too (a folder named by the pattern), except after a last part with a lone
  // * in it: GitHub's docs/* is only the files right in docs. A folder pattern (trailing /) is only what's in it.
  const lone = /\*/.test(last) && last !== '**';
  const tail = folder ? '/.*' : lone ? '' : '(?:/.*)?';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${tail}$`);
}

/**
 * Who owns `path`: { owners, sections: [{ name, owners, rule }] }, one entry per section with a matching
 * line (its last one), owners in the order the file names them, each once.
 */
export function ownersOf(parsed, path) {
  if (!parsed) return { owners: [], sections: [] };
  const p = String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
  const sections = [];
  for (const section of parsed.sections) {
    let hit = null;
    for (const rule of parsed.rules) if (rule.section === section.name && rule.re.test(p)) hit = rule;
    if (!hit) continue;
    sections.push({ name: section.name, optional: section.optional, owners: hit.owners.length ? hit.owners : section.owners, rule: hit });
  }
  const owners = [];
  for (const s of sections) if (!s.optional) for (const o of s.owners) if (!owners.includes(o)) owners.push(o);
  // Optional sections' owners come last: they're asked, not required.
  for (const s of sections) if (s.optional) for (const o of s.owners) if (!owners.includes(o)) owners.push(o);
  return { owners, sections };
}

/** For several paths: [{ owner, files }] (most files first), and the paths nobody owns. */
export function ownersOfFiles(parsed, paths) {
  const by = new Map();
  const unowned = [];
  for (const path of paths) {
    const { owners } = ownersOf(parsed, path);
    if (!owners.length) unowned.push(path);
    for (const o of owners) {
      if (!by.has(o)) by.set(o, []);
      by.get(o).push(path);
    }
  }
  const owners = [...by].map(([owner, files]) => ({ owner, files })).sort((a, b) => b.files.length - a.files.length || a.owner.localeCompare(b.owner));
  return { owners, unowned };
}

/** Owners as a short line ("@ana @org/web +2"), at most `max` of them named. */
export function ownersLine(owners, max = 3) {
  if (!owners?.length) return '';
  return owners.length > max ? `${owners.slice(0, max).join(' ')} +${owners.length - max}` : owners.join(' ');
}

/**
 * The owners a pull request can ask to review: users and teams named with @ (an email isn't a reviewer
 * name gh or glab take), without the @, leaving out `me` (your own login on the host) in any case.
 */
export function reviewerNames(owners, me = '') {
  const self = String(me ?? '').replace(/^@/, '').toLowerCase();
  const out = [];
  for (const o of owners) {
    if (!o.startsWith('@')) continue;
    const name = o.slice(1);
    if (!name || name.toLowerCase() === self || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** /owners <path>: what the viewer says about one path. */
export function ownersText(file, parsed, path) {
  const { owners, sections } = ownersOf(parsed, path);
  const lines = [`${path}`, ''];
  if (!sections.length) lines.push(`No line of ${file} matches it, so nobody owns it.`);
  for (const s of sections) {
    const where = `${file}:${s.rule.line}  ${s.rule.pattern}`;
    const head = s.name ? `[${s.name}]${s.optional ? ' (optional)' : ''}  ` : '';
    lines.push(s.owners.length ? `${head}${s.owners.join(' ')}` : `${head}nobody (the line names no owners)`, `  from ${where}`);
  }
  if (owners.length) lines.push('', `Owners: ${owners.join(' ')}`);
  return lines.join('\n');
}

/** /owners alone: the changed files' owners, each with the files that are theirs. */
export function changedOwnersText(file, parsed, paths) {
  const { owners, unowned } = ownersOfFiles(parsed, paths);
  const lines = [`The owners of your ${paths.length} changed file${paths.length === 1 ? '' : 's'}, from ${file}`, ''];
  for (const { owner, files } of owners) {
    lines.push(`${owner}  (${files.length})`);
    for (const f of files) lines.push(`  ${f}`);
  }
  if (unowned.length) {
    if (owners.length) lines.push('');
    lines.push(`Nobody  (${unowned.length})`);
    for (const f of unowned) lines.push(`  ${f}`);
  }
  return lines.join('\n');
}
