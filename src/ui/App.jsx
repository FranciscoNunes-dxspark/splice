import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as a from '../actions.js';
import { findCommand, suggestionsFor } from '../commands.js';
import { samePath, saveConfig, withRecent } from '../config.js';
import { git, run } from '../git.js';
import { HELP } from '../help.js';
import { changeDiff, commitPatch, findRepo, loadRepo, snapshot, stashPatch } from '../repo.js';
import { discover, eachLimited, summarize } from '../repos.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { VERSION } from '../version.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Panel, PromptBox, Row, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { BranchesView } from './BranchesView.jsx';
import { ChangesView } from './ChangesView.jsx';
import { GraphView } from './GraphView.jsx';
import { ReposView } from './ReposView.jsx';
import { StashView } from './StashView.jsx';
import { WorktreesView } from './WorktreesView.jsx';
import { PrView } from './PrView.jsx';
import { hostFor, openUrl } from '../hosting.js';
import { TextViewer } from './TextViewer.jsx';
import { RebaseEditor } from './RebaseEditor.jsx';
import { WELCOME_HEIGHT, Welcome } from './Knot.jsx';
import { FACES, moodFor } from '../knot.js';

const VIEWS = [
  { id: 'graph', label: 'Graph' },
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'stash', label: 'Stash' },
  { id: 'prs', label: 'PRs' },
  { id: 'repos', label: 'Repos' },
];

const HINTS = {
  graph: '↵ diff · c checkout · b branch · m merge · i rebase from here · C cherry-pick · v revert · X reset · e/R Claude explains/reviews',
  changes: 'space stage · ↵ hunks/lines · a all · u unstage all · d discard · c commit · A amend · W Claude writes it · R review',
  branches: '↵ checkout · n new · m merge · e rebase · d delete',
  stash: '↵ diff · s stash · a apply · o pop · x drop',
  prs: '↵ diff · c checkout · a approve · C comment · o open in browser · n new PR · W Claude drafts one · e/R explain/review',
  repos: '↵ open · s scan folder · x forget',
  worktrees: '↵ open · n new · x remove or prune',
};

const POLL_MS = 3000;
const firstLine = (s) => String(s ?? '').split('\n')[0];
const showArg = (s) => (/[\s"]/.test(s) || s === '' ? JSON.stringify(s) : s);

function Header({ data, width, loading, mood }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Tiller', bold: true },
  ];
  if (data) {
    const b = data.status.branch;
    segs.push({ text: '  │  ', color: theme.border }, { text: data.name, bold: true });
    segs.push({ text: '  ⎇ ', color: theme.dim }, { text: b.head ?? `detached at ${(b.oid ?? '').slice(0, 7)}`, color: b.head ? theme.local : theme.warn, bold: true });
    if (b.upstream) segs.push({ text: ` → ${b.upstream}`, color: theme.dim });
    if (b.ahead) segs.push({ text: ` ↑${b.ahead}`, color: theme.add, bold: true });
    if (b.behind) segs.push({ text: ` ↓${b.behind}`, color: theme.warn, bold: true });
    const n = data.status.files.length;
    segs.push({ text: n ? `  ● ${n} change${n === 1 ? '' : 's'}` : '  ✓ clean', color: n ? theme.warn : theme.dim });
    if (data.state) segs.push({ text: '  ' }, { text: ` ${data.state.toUpperCase()} `, bg: theme.del, color: theme.ink, bold: true });
  } else if (loading) {
    segs.push({ text: '  loading…', color: theme.dim });
  }
  // The path gives way first, keeping its end (the repo folder) and losing its start.
  const full = data ? data.root : '';
  const pathW = Math.min(stringWidth(full), Math.max(0, width - 60));
  const path = pathW < full.length ? `…${full.slice(-(pathW - 1))}` : full;
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, width - pathW - 1), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

function Tabs({ view, data, width }) {
  const segs = [];
  VIEWS.forEach((v, i) => {
    let label = `${i + 1} ${v.label}`;
    if (data && v.id === 'changes' && data.status.files.length) label += ` ${data.status.files.length}`;
    if (data && v.id === 'stash' && data.stashes.length) label += ` ${data.stashes.length}`;
    if (data && v.id === 'worktrees' && data.worktrees.length > 1) label += ` ${data.worktrees.length}`;
    const on = v.id === view;
    segs.push({ text: ` ${label} `, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  });
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● git push" then "  ⎿  output".
function activityRows(entries) {
  const out = [];
  for (const e of entries.slice(-2)) {
    const color = { error: theme.del, ok: theme.accent, running: theme.dim, info: theme.hunk }[e.status];
    out.push([{ text: `${BULLET} `, color }, { text: e.title, bold: e.status !== 'info' }]);
    const max = e.status === 'error' ? 3 : 2;
    e.lines.slice(0, max).forEach((l, i) =>
      out.push([{ text: i === 0 ? '  ⎿  ' : '     ', color: theme.dim }, { text: l, color: e.status === 'error' ? theme.del : theme.dim }]),
    );
    if (e.lines.length > max) out.push([{ text: '     ' }, { text: `… +${e.lines.length - max} lines (/last to see all)`, color: theme.dim }]);
  }
  return out.slice(-6);
}

export function App({ initialPath, config: initialConfig, checkUpdate, askClaude }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('graph');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [repos, setRepos] = useState([]);
  const [filter, setFilter] = useState('');
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  // Knot looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  const [prVersion, setPrVersion] = useState(0);

  // Async actions read the latest state through refs, not through stale closures.
  const repoRef = useRef(null);
  const dataRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const extraRoots = useRef([]);
  const seq = useRef(0);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  const polling = useRef(false);
  const loadingMore = useRef(false);

  const setConfig = (update) => {
    const next = update(configRef.current);
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  };

  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const setFocus = (f) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const setOverlay = (next) => {
    overlayRef.current = typeof next === 'function' ? next(overlayRef.current) : next;
    setOverlayState(overlayRef.current);
  };

  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };

  const addEntry = (e) => {
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-19), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  const removeEntry = (id) => setEntries((list) => list.filter((e) => e.id !== id));

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  const reload = async ({ graphLimit } = {}) => {
    const repo = repoRef.current;
    if (!repo) return;
    const mine = ++seq.current;
    try {
      const d = await loadRepo(repo, { graphLimit: graphLimit ?? dataRef.current?.graphLimit ?? 400 });
      // A newer load (or another repo) wins over this one.
      if (mine !== seq.current || repoRef.current !== repo) return;
      d.loadedAt = mine;
      dataRef.current = d;
      setData(d);
    } catch (e) {
      if (repoRef.current === repo) note(`Couldn't read ${repo.name}: ${firstLine(e.message)}`, 'error');
    }
  };

  // One command at a time, with the spinner, esc to cancel, and a line in the activity log.
  // `start(signal)` resolves with { stdout, stderr }.
  const task = async (title, start, { label = 'Working', refresh = true, quiet = false, quietError = false } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const repo = repoRef.current;
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = quiet ? null : addEntry({ title, status: 'running' });
    setWelcome(false);
    try {
      const { stdout, stderr } = await start(controller.signal);
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      if (id) updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      return { ok: true, out };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      const lines = error.message.split('\n');
      if (error.cancelled) id ? updateEntry(id, { status: 'error', lines: ['Cancelled'] }) : note('Cancelled', 'error');
      else if (quietError) id && removeEntry(id);
      else if (id) updateEntry(id, { status: 'error', lines });
      else addEntry({ title, status: 'error', lines });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh && repo) await reload();
    }
  };

  const exec = (args, { anywhere = false, input, env, ...opts } = {}) => {
    const repo = repoRef.current;
    if (!repo && !anywhere) {
      note('Open a repository first.', 'error');
      return Promise.resolve({ ok: false, error: new Error('no repository') });
    }
    const title = `git ${args.map(showArg).join(' ')}`;
    return task(title, (signal) => run(repo?.root ?? process.cwd(), args, { signal, input, env }), { label: 'Running git', ...opts });
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    setConfirmReq(null);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
  };

  // `summaries` runs git status in every listed repo, which only the Repos view shows.
  const refreshRepos = async (roots = extraRoots.current, { summaries = true } = {}) => {
    extraRoots.current = roots;
    const cfg = configRef.current;
    const found = await discover([...cfg.roots, ...roots]);
    const paths = [];
    for (const p of [...cfg.recent, ...found]) if (!paths.some((q) => samePath(q, p))) paths.push(p);
    const list = paths.map((p) => ({ path: p, name: basename(p) }));
    setRepos(list);
    if (!summaries) return;
    eachLimited(list, 4, (r) => summarize(r.path), (r, summary) =>
      setRepos((cur) => cur.map((x) => (x.path === r.path ? { ...x, summary } : x))),
    );
  };

  const openRepo = async (path, { silent = false } = {}) => {
    let repo;
    try {
      repo = await findRepo(resolve(path));
    } catch (e) {
      if (!silent) note(firstLine(e.message), 'error');
      return false;
    }
    repoRef.current = repo;
    dataRef.current = null;
    setData(null);
    setFilter('');
    setOverlay(null);
    setLoading(true);
    await reload();
    setLoading(false);
    setConfig((c) => withRecent(c, repo.root));
    setView((v) => (v === 'repos' ? 'graph' : v));
    return true;
  };

  const showAsync = (title, load, opts = {}) => {
    const token = {};
    setOverlay({ title, loading: true, token, ...opts });
    load().then(
      (text) => setOverlay((o) => (o?.token === token ? { ...o, loading: false, text } : o)),
      (e) => setOverlay((o) => (o?.token === token ? { ...o, loading: false, text: e.message } : o)),
    );
  };

  const ctxRef = useRef(null);
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; } };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    exec,
    task,
    // A read that doesn't show in the activity lines or block other commands.
    git: (args) => git(repoRef.current.root, args),
    // The PR host (GitHub or Azure DevOps) of the open repository, kept while the remotes don't change.
    host: () => {
      const d = dataRef.current;
      const key = d ? `${d.root}|${JSON.stringify(d.remoteUrls)}` : null;
      if (ctx.hostCache?.key !== key) ctx.hostCache = { key, host: d ? hostFor(d) : null };
      return ctx.hostCache.host;
    },
    prsChanged: () => setPrVersion((v) => v + 1),
    // claude.js's `ask`, from cli.jsx. Tests pass a stub, or nothing (and the Claude keys say it's unavailable).
    askClaude,
    openUrl,
    note,
    confirm,
    prefill,
    reload,
    openRepo,
    setView,
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current,
    quit: () => exit(),
    refresh: () => {
      reload();
      refreshRepos();
      setPrVersion((v) => v + 1);
    },
    loadMore: () => {
      const d = dataRef.current;
      if (!d || d.graphComplete || loadingMore.current) return;
      loadingMore.current = true;
      reload({ graphLimit: d.graphLimit + 400 }).finally(() => (loadingMore.current = false));
    },
    find: (text) => {
      setFilter(text.trim());
      setView('graph');
    },
    addRoot: (dir) => {
      if (!dir) return prefill('/scan ');
      const full = resolve(dir);
      if (!existsSync(full)) return note(`${full} doesn't exist.`, 'error');
      setConfig((c) => ({ ...c, roots: [...c.roots.filter((r) => !samePath(r, full)), full] }));
      note(`Scanning ${full} for repositories`);
      setView('repos');
      refreshRepos();
    },
    forgetRepo: (path) => {
      setConfig((c) => ({ ...c, recent: c.recent.filter((r) => !samePath(r, path)) }));
      refreshRepos();
    },
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
    showRebase: (plan) => setOverlay({ kind: 'rebase', plan }),
    closeOverlay: () => {
      ctx.rebaseEditor = null;
      setOverlay(null);
    },
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current,
    showHelp: () => setOverlay({ title: 'Keyboard shortcuts', text: HELP }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
    showPatch: (c) => showAsync(`${c.hash.slice(0, 7)} ${c.subject}`, () => commitPatch(dataRef.current.root, c.hash), { diff: true }),
    showChange: (f) => showAsync(`${f.path} (${f.area})`, () => changeDiff(dataRef.current.root, f), { diff: true }),
    showPrDiff: (pr) => showAsync(`${pr.label} ${pr.title}`, () => ctx.host().diff(pr), { diff: true }),
    showStash: (s) => showAsync(`${s.ref} ${s.message}`, () => stashPatch(dataRef.current.root, s.ref), { diff: true }),
  });

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    try {
      if (text.startsWith('!')) return await a.raw(ctx, text.slice(1));
      if (/^git(\s|$)/.test(text)) return await a.raw(ctx, text);
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) return note(`Unknown command: /${name}. Type / to see them all.`, 'error');
      await cmd.run(ctx, rest.trim());
    } catch (e) {
      note(firstLine(e.message), 'error');
    }
  };

  // First load: the given folder if it's a repo, otherwise the repo picker scanning that folder.
  useEffect(() => {
    (async () => {
      const ok = await openRepo(initialPath, { silent: true });
      setLoading(false);
      if (!ok) {
        setView('repos');
        note(`${initialPath} isn't inside a git repository. Pick one below, or /open <path>.`);
      }
      // Opening a repo only needs the paths (for /open completion); the Repos view fills in the rest when shown.
      refreshRepos(ok ? [] : [initialPath], { summaries: !ok });
      // After the first load, so it doesn't slow it down. cli.jsx passes the check; tests don't, so they stay offline.
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            setUpdate(checked);
            note(`Tiller ${checked.latest} is out (you have ${VERSION}).\nDownload it from ${checked.url}`);
          },
          // Offline, or no way to ask: try again next time.
          () => {},
        );
      }
    })();
  }, []);

  useEffect(() => {
    if (view === 'repos') refreshRepos();
  }, [view]);

  // Notice changes made outside Tiller (an editor saving, a commit from another terminal).
  useEffect(() => {
    const t = setInterval(async () => {
      const repo = repoRef.current;
      if (!repo || !dataRef.current || busyRef.current || polling.current) return;
      polling.current = true;
      try {
        const snap = await snapshot(repo);
        if (repoRef.current === repo && dataRef.current && snap.signature !== dataRef.current.signature) await reload();
      } catch {
        // The repo may be mid-operation or gone; the next tick tries again.
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, repos }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataRef.current, repos });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
    if (key.ctrl && input === 'c') return value ? edit('', 0) : exit();
    if (key.escape) return setFocus('view');
    if (key.return) {
      if (pick && value.trim() !== pick.insert.trim()) return pick.run ? submit(pick.insert) : edit(pick.insert);
      return submit(value);
    }
    if (key.tab) return pick ? edit(pick.insert) : undefined;
    if (key.upArrow || key.downArrow) {
      if (items.length) return setSugIndex((s) => (s + (key.upArrow ? items.length - 1 : 1)) % items.length);
      const history = configRef.current.history ?? [];
      const pos = Math.max(-1, Math.min(history.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : history[pos]);
    }
    if (key.leftArrow) return setPrompt(value, Math.max(0, cursor - 1));
    if (key.rightArrow) return setPrompt(value, Math.min(value.length, cursor + 1));
    // Most terminals send DEL for backspace, which Ink reports as `delete`.
    if (key.backspace || key.delete) {
      if (!value) return setFocus('view');
      if (cursor > 0) edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl && input === 'a') return setPrompt(value, 0);
    if (key.ctrl && input === 'e') return setPrompt(value, value.length);
    if (key.ctrl && input === 'u') return edit(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const start = value.slice(0, cursor).replace(/\S+\s*$/, '').length;
      return edit(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  // Keys that work in every view.
  const globalKeys = (input, key) => {
    if (key.escape) {
      if (busyRef.current) busyRef.current.abort();
      else if (!filter || view !== 'graph') {
        setEntries([]);
        setWelcome(false);
      }
      return;
    }
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
    if (input === 'f') return a.fetch(ctx);
    if (input === 'p') return a.pull(ctx);
    if (input === 'P') return a.push(ctx);
    if (input === 'r') return ctx.refresh();
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    if (focusRef.current === 'prompt' && !confirmRef.current) return promptKeys(input, key);
    if (key.ctrl && input === 'c') return exit();
    if (confirmRef.current || overlayRef.current) return;
    globalKeys(input, key);
  });

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  const act = activityRows(entries);
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ data, busy, lastEntry: entries.at(-1) });
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;

  let main;
  if (overlay?.kind === 'rebase') {
    main = <RebaseEditor plan={overlay.plan} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => setOverlay(null)} />;
  } else if (view === 'repos') {
    main = <ReposView repos={repos} roots={[...config.roots, ...extraRoots.current]} current={data?.root} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!data) {
    main = (
      <Panel title={VIEWS.find((v) => v.id === view).label} width={W} height={mainH}>
        <Text color={theme.dim}>{loading ? '  Loading…' : '  No repository open. Press 7 to pick one, or /open <path>.'}</Text>
      </Panel>
    );
  } else {
    const View = { graph: GraphView, changes: ChangesView, branches: BranchesView, stash: StashView, prs: PrView, worktrees: WorktreesView }[view];
    main = <View data={data} ctx={ctx} width={W} height={mainH} active={viewActive} filter={filter} prVersion={prVersion} />;
  }

  const left =
    focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'rebase'
        ? '↵ start the rebase · esc cancel'
        : overlay
          ? 'j/k scroll · space page · n/N hunk · esc close'
          : HINTS[view];
  const right = focus === 'prompt' ? '' : '  f fetch · p pull · P push · / commands · ! git · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} width={W} loading={loading} mood={mood} />
      <Tabs view={view} data={data} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={data} width={W} update={update} /> : null}
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder='Press / for commands (try "/commit fix typo"), ! to run git, ? for shortcuts' />
      )}
      {suggestions.length ? <Suggestions items={suggestions} selected={sel} width={W} /> : null}
      <Row
        pointer={false}
        width={W}
        segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]}
      />
    </Box>
  );
}
