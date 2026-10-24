import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, completionKind, findCommand, suggestionsFor } from '../commands.js';
import { samePath, saveConfig, withRecent } from '../config.js';
import { git, run } from '../git.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '../help-layout.js';
import { canonical, changeDiff, commitPatch, findRepo, loadRepo, snapshot, stashFileDiff, stashPatch } from '../repo.js';
import { discover, eachLimited, summarize } from '../repos.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { VERSION } from '../version.js';
import { useKeyTranslation, useTerminalSize } from './hooks.js';
import { keymapSection, parseKeymap, translateKey } from '../keymap.js';
import { expandLines, userCommands } from '../usercommands.js';
import { paletteItems } from '../palette.js';
import { Palette } from './Palette.jsx';
import { Confirm, Panel, PromptBox, Row, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { BranchesView } from './BranchesView.jsx';
import { ChangesView } from './ChangesView.jsx';
import { GraphView } from './GraphView.jsx';
import { ReposView } from './ReposView.jsx';
import { StashView } from './StashView.jsx';
import { WorktreesView } from './WorktreesView.jsx';
import { PrView } from './PrView.jsx';
import { hostFor, openUrl } from '../hosting.js';
import { HelpView } from './HelpView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { Picker } from './Picker.jsx';
import { RebaseEditor } from './RebaseEditor.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, moodFor } from '../pet.js';
import { worthNotifying } from '../notify.js';
import { decodeContext, pastedLine, readMoods, writeMood } from '../family.js';
import { droppedPaths } from '../drop.js';
import { ownersLine, ownersOf } from '../codeowners.js';
import { familyMood, moodsToShow, reactionText } from '../siblings.js';

const VIEWS = [
  { id: 'graph', label: 'Graph' },
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'stash', label: 'Stash' },
  { id: 'prs', label: 'PRs' },
  { id: 'repos', label: 'Repos' },
];

const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));

// What ? shows: help.js's sections, the keys you mapped, then the slash commands, yours with them.
const helpSections = (user, keymap) => [...HELP, ...[keymapSection(keymap, VIEW_LABELS)].filter(Boolean), commandsSection([...COMMANDS, ...user])];

// ctrl+p, as the terminal sends it: the command palette.
const CTRL_P = '\x10';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const HINTS = {
  graph: '↵ diff · c checkout · b branch · m merge · i rebase from here · C cherry-pick · V select several · v revert · X reset · B bisect · w run it (Bosun) · Y for Sonar · e/R Claude explains/reviews',
  changes: 'space stage · ↵ hunks/lines · a all · u unstage all · d discard · i ignore · s stash file · v select files · c commit · A amend · M message in your editor · F fix up · H history · B blame · L LFS lock · W Claude writes it · S splits it · R review · on a submodule: I init/update · o open',
  branches: '↵ checkout · n new · m merge · e rebase · d delete · D diff vs default · o open PR · S sync · B update branch · C clean up · U upstream · M remotes · on a tag: u push · R release',
  stash: '↵ diff · s stash · S with a message · a apply · o pop · x drop · F files, to restore one',
  prs: '↵ diff · c checkout · w review in a worktree · a approve · m merge · s checks · A reviewers · D draft/ready · E title · B description · C comment · o open in browser · n new PR · W Claude drafts one · e/R explain/review',
  repos: '↵ open · F fetch them all · s scan folder · x forget',
  worktrees: '↵ open · n new · x remove or prune · C clean up',
};

const POLL_MS = 3000;
const firstLine = (s) => String(s ?? '').split('\n')[0];
const showArg = (s) => (/[\s"]/.test(s) || s === '' ? JSON.stringify(s) : s);

function Header({ data, width, loading, mood }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Splice', bold: true },
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
    // Only part of the repository is checked out (/sparse says which).
    if (data.sparse?.on) segs.push({ text: '  sparse', color: theme.hunk, bold: true });
    if (data.state) segs.push({ text: '  ' }, { text: ` ${data.state.toUpperCase()} `, bg: data.state === 'bisecting' ? theme.hunk : theme.del, color: theme.ink, bold: true });
  } else if (loading) {
    segs.push({ text: '  loading…', color: theme.dim });
  }
  // The path gives way first, keeping its end (the repo folder) and losing its start: the branch, the changes
  // and a merge or rebase in progress matter more, however long the path (as in a Windows temp folder).
  const full = data ? data.root : '';
  const room = width - 1 - segs.reduce((n, s) => n + stringWidth(s.text), 0);
  const pathW = room >= 12 ? Math.min(stringWidth(full), room) : 0;
  if (!pathW) return <Row pointer={false} width={width} segments={fitSegments(segs, width)} />;
  const path = pathW < stringWidth(full) ? `…${full.slice(-(pathW - 1))}` : full;
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, width - pathW - 1), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

/** The terminal window's title: the repo and branch, which is what tells one Splice tab from another. */
export function windowTitle(data) {
  if (!data) return 'Splice';
  const b = data.status.branch;
  return `${data.name} (${b.head ?? `detached at ${(b.oid ?? '').slice(0, 7)}`}) — Splice`;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(data) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let label = ` ${i + 1} ${v.label}`;
    if (data && v.id === 'changes' && data.status.files.length) label += ` ${data.status.files.length}`;
    if (data && v.id === 'stash' && data.stashes.length) label += ` ${data.stashes.length}`;
    if (data && v.id === 'worktrees' && data.worktrees.length > 1) label += ` ${data.worktrees.length}`;
    label += ' ';
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, data, width }) {
  const segs = [];
  for (const t of tabLabels(data)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
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

const DOUBLE_CLICK_MS = 400;

// `makeHost(data, config)` stands in for hosting.js's hostFor in tests, so they never call gh, az or glab. `mouse` is
// mouse.js's terminalMouse() from cli.jsx (missing where the terminal can't report it); tests pass their own.
// `copy` puts text on the clipboard (cli.jsx's; tests pass a stub). `notify(title, body)` says something
// finished (cli.jsx rings the terminal's bell and raises a desktop notification); without it, as in most
// tests, nothing is said. `familyHome` is the family's folder for the mascots' moods (family.js's familyDir,
// from cli.jsx): without it, as in most tests, Twig neither tells the siblings its mood nor reads theirs;
// `moodEvery` is how often theirs are read. It's also where Splice logs what it did, for the family's /timeline.
export function App({ initialPath, reopenLast = false, config: initialConfig, checkUpdate, installUpdate, askClaude, setTitle, makeHost = hostFor, mouse, copy, notify, familyHome = null, moodEvery = 30_000 }) {
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
  const reposRef = useRef(repos);
  reposRef.current = repos;
  // F in Repos: how many of the listed repositories have been fetched so far, while it runs.
  const [fetchProgress, setFetchProgress] = useState(null);
  const [filter, setFilter] = useState(null);
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  const [prVersion, setPrVersion] = useState(0);
  // A sibling's mood worth a word ("Ping says: …"), until esc puts it away.
  const [reaction, setReaction] = useState(null);
  // Counts ctx.showInGraph calls, so the graph looks for the commit asked for (ctx.pendingJump).
  const [jump, setJump] = useState(0);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  // Errors said and questions answered no, counted so a line of your own command knows it failed.
  const errorCount = useRef(0);
  const declines = useRef(0);
  // Your own commands and keys (the config's "commands" and "keys"), and what was wrong with them.
  const custom = useMemo(() => {
    const mine = userCommands(config.commands, COMMANDS.map((c) => c.name));
    const commands = mine.commands.map((c) => ({ ...c, run: (_, rest) => ctx.runUserCommand(c, rest) }));
    const keymap = parseKeymap(config.keys, VIEWS.map((v) => v.id));
    return { commands, keymap, sections: helpSections(commands, keymap), problems: [...mine.problems.map((p) => `commands: ${p}`), ...keymap.problems.map((p) => `keys: ${p}`)] };
  }, [config.commands, config.keys]);
  const customRef = useRef(custom);
  customRef.current = custom;
  const viewRef = useRef(view);
  viewRef.current = view;
  // A key picked in the palette, sent to the view once it's back on screen (the effect below).
  const pendingKey = useRef(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // Async actions read the latest state through refs, not through stale closures.
  const repoRef = useRef(null);
  const dataRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const extraRoots = useRef([]);
  const seq = useRef(0);
  const latestLoad = useRef(null);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  const polling = useRef(false);
  const loadingMore = useRef(false);
  // Counts keypresses, ahead of every handler, so the dispatcher can tell the key that opened the prompt.
  const keySeq = useRef(0);
  const prefillKey = useRef(-1);
  // The key that answered the last confirmation: it's that one's, and no other handler's.
  const answerKey = useRef(-1);
  const { internal_eventEmitter: inputEvents } = useStdin();
  useEffect(() => {
    if (!inputEvents) return;
    const count = () => keySeq.current++;
    inputEvents.prependListener('input', count);
    return () => inputEvents.removeListener('input', count);
  }, [inputEvents]);

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
    const cur = overlayRef.current;
    let o = typeof next === 'function' ? next(cur) : next;
    // An overlay opened from a picker (a diff of the picked commit) goes back to the picker when closed.
    if (o && o !== cur && !o.back && cur?.kind === 'picker' && typeof next !== 'function') o = { ...o, back: cur };
    overlayRef.current = o;
    // The last blame shown, for /future without a line (Picker.jsx keeps its cursor on it as `index`).
    if (o?.kind === 'picker' && o.blame) lastBlame.current = { picker: o, root: ctx.data?.root };
    setOverlayState(o);
  };
  const lastBlame = useRef(null);
  const pickerIds = useRef(0);

  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };

  const addEntry = (e) => {
    if (e.status === 'error') errorCount.current++;
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-19), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => {
    if (patch.status === 'error') errorCount.current++;
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  };
  const removeEntry = (id) => setEntries((list) => list.filter((e) => e.id !== id));

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  const reload = async ({ graphLimit, freshRefs = false } = {}) => {
    const repo = repoRef.current;
    if (!repo) return;
    const mine = ++seq.current;
    const load = (async () => {
      try {
        const d = await loadRepo(repo, { graphLimit: graphLimit ?? dataRef.current?.graphLimit ?? 400, freshRefs });
        if (repoRef.current !== repo) return;
        // A newer load wins over this one. It started later, so whoever awaits this one waits for it
        // too: a command reading ctx.data after `await reload()` (the poller's reload having started
        // in between) must not see the data from before it ran.
        if (mine !== seq.current) return latestLoad.current;
        d.loadedAt = mine;
        dataRef.current = d;
        setData(d);
      } catch (e) {
        if (repoRef.current === repo) note(`Couldn't read ${repo.name}: ${firstLine(e.message)}`, 'error');
      }
    })();
    latestLoad.current = load;
    return load;
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
    // A long run that ends says so, for when you've looked away (Settings' "Notify when done"). Claude's
    // answers run quietly, with no line of their own, so theirs just says it's done.
    const tell = (line) => notify && worthNotifying(Date.now() - b.started, configRef.current) && notify(`Splice: ${title}`, `${line}${repo ? ` (${repo.name})` : ''}`);
    try {
      const { stdout, stderr } = await start(controller.signal);
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      if (id) updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      tell(quiet || !out ? 'Done' : firstLine(out));
      return { ok: true, out };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      const lines = error.message.split('\n');
      if (error.cancelled) id ? updateEntry(id, { status: 'error', lines: ['Cancelled'] }) : note('Cancelled', 'error');
      else if (quietError) id && removeEntry(id);
      else if (id) updateEntry(id, { status: 'error', lines });
      else addEntry({ title, status: 'error', lines });
      if (!error.cancelled && !quietError) tell(`Failed: ${firstLine(error.message)}`);
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh && repo) await reload();
    }
  };

  // `tree`: esc stops what git runs as well (git bisect run's command), not git alone.
  const exec = (args, { anywhere = false, input, env, tree, ...opts } = {}) => {
    const repo = repoRef.current;
    if (!repo && !anywhere) {
      note('Open a repository first.', 'error');
      return Promise.resolve({ ok: false, error: new Error('no repository') });
    }
    const title = `git ${args.map(showArg).join(' ')}`;
    return task(title, (signal) => run(repo?.root ?? process.cwd(), args, { signal, input, env, tree }), { label: 'Running git', ...opts });
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
    answerKey.current = keySeq.current;
    if (value === false || value == null) declines.current++;
    setConfirmReq(null);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
    // Noted so that the key that did this (c in Changes, say) isn't also typed into the prompt (see the dispatcher).
    prefillKey.current = keySeq.current;
  };

  // `summaries` runs git status in every listed repo, which only the Repos view shows.
  const refreshRepos = async (roots = extraRoots.current, { summaries = true } = {}) => {
    extraRoots.current = roots;
    const cfg = configRef.current;
    const found = await discover([...cfg.roots, ...roots]);
    const paths = [];
    for (const p of [...cfg.recent, ...found]) if (!paths.some((q) => samePath(q, p))) paths.push(p);
    // By name, so opening one doesn't move it: `recent` stays newest first for reopening the last one.
    const list = paths.map((p) => ({ path: p, name: basename(p) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path));
    // The summaries from last time stay up while new ones come in: git status takes up to a second in a big repo.
    // So does what the last F said about each one's fetch.
    setRepos((cur) => list.map((r) => {
      const was = cur.find((x) => samePath(x.path, r.path));
      return { ...r, summary: was?.summary, fetch: was?.fetch };
    }));
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
    setFilter(null);
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
  // `promptText`: what's typed in the prompt, which stays there while you're back in the view (M in Changes starts a message file from it).
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; }, get config() { return configRef.current; }, get promptText() { return promptRef.current.value; }, get repos() { return reposRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    exec,
    task,
    // A read that doesn't show in the activity lines or block other commands. `opts.signal` cancels it.
    git: (args, opts) => git(repoRef.current.root, args, opts),
    // The PR host (GitHub, Azure DevOps or GitLab) of the open repository, kept while the remotes (and the
    // config's `hosts`, which names self-managed GitLab servers) don't change.
    host: () => {
      const d = dataRef.current;
      const hosts = configRef.current?.hosts;
      const key = d ? `${d.root}|${JSON.stringify(d.remoteUrls)}|${JSON.stringify(hosts ?? null)}` : null;
      if (ctx.hostCache?.key !== key) ctx.hostCache = { key, host: d ? makeHost(d, configRef.current) : null };
      return ctx.hostCache.host;
    },
    prsChanged: () => setPrVersion((v) => v + 1),
    // Whether a command is running (the spinner): what the PR list's poll checks before asking anything.
    isBusy: () => Boolean(busyRef.current),
    // What the PR list's poll found on your own pull requests (prList.js): checks finished, a new review.
    prNews: (news) => {
      for (const n of news) {
        note(`${n.title}: ${n.body}`);
        if (notify && configRef.current.notify !== false) notify(`Splice: ${n.title}`, n.body);
      }
    },
    // claude.js's `ask`, from cli.jsx. Tests pass a stub, or nothing (and the Claude keys say it's unavailable).
    askClaude,
    // Whether this terminal can report the mouse at all (/settings says so).
    mouseAvailable: Boolean(mouse),
    // The family's folder (cli.jsx's familyDir(); tests a temp one, or none): what Splice did goes into its
    // activity log (/timeline) only when there is one.
    familyHome,
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (!checkUpdate) return note(`This Splice (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Splice ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Splice ${update.latest} is installed. It starts the next time you open Splice.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Splice',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Splice ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Splice ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Splice ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Splice ${checked.latest} is installed. It starts the next time you open Splice.`);
        },
        { label: 'Updating Splice', refresh: false },
      );
    },
    // y in the views: `text` to the clipboard, said in the bottom line as "Copied <what>".
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    openUrl,
    note,
    confirm,
    prefill,
    reload,
    openRepo,
    setView,
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
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
    // The graph's filter: text matches the loaded commits; { mode: 'S' | 'G', query, rows } holds a history search's results.
    // Puts the graph's cursor on a commit (the first bad one a bisect found), now or when the graph is next on screen.
    showInGraph: (hash) => {
      ctx.pendingJump = { hash, root: repoRef.current?.root };
      setJump((n) => n + 1);
    },
    find: (f) => {
      setFilter(typeof f === 'string' ? (f.trim() ? { mode: 'text', query: f.trim() } : null) : f);
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
      // Added from the folders list in /settings: show it there.
      a.redrawSettings(ctx);
    },
    // A Repos row's fetch (F): { state: 'fetching' | 'done' | 'failed', error }, and its summary after it.
    // `path` null clears every row's.
    setRepoFetch: (path, fetch, summary) =>
      setRepos((cur) =>
        cur.map((x) => (path === null ? { ...x, fetch: undefined } : samePath(x.path, path) ? { ...x, fetch, ...(summary ? { summary } : {}) } : x)),
      ),
    setFetchProgress,
    // A dropped folder that isn't a repository: the Repos view, with the ones inside it (as `splice <folder>`).
    showReposIn: (dir) => {
      const full = canonical(resolve(dir));
      extraRoots.current = [...extraRoots.current.filter((r) => !samePath(r, full)), full];
      note(`${basename(full)} isn't a git repository. Repos lists the ones inside it.`);
      if (view === 'repos') refreshRepos();
      else setView('repos');
    },
    forgetRepo: (path) => {
      setConfig((c) => ({ ...c, recent: c.recent.filter((r) => !samePath(r, path)) }));
      refreshRepos();
    },
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
    // The viewer, saying Loading… until `load()` resolves with its text.
    showAsync,
    showRebase: (plan) => setOverlay({ kind: 'rebase', plan }),
    // A list to pick from: { title, hint, items | load, onPick, keys, empty } (see Picker.jsx).
    // `replace`: swaps the picker on screen for this one (the same list, redrawn after a change), keeping
    // where it goes back to, instead of opening on top of it.
    showPicker: (picker, { replace = false } = {}) => {
      const next = { ...picker, kind: 'picker', id: ++pickerIds.current };
      if (replace) setOverlay((cur) => ({ ...next, back: cur?.back }));
      else setOverlay(next);
    },
    overlay: () => overlayRef.current,
    // The blame picker last on screen in this repository (open or not), or null.
    lastBlame: () => (lastBlame.current && lastBlame.current.root === ctx.data?.root ? lastBlame.current.picker : null),
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    closeOverlay: () => {
      const closing = overlayRef.current;
      ctx.rebaseEditor = null;
      ctx.reviewThread = null;
      ctx.reviewLine = null;
      // As a function, so a picker going back to another picker (blame to history) isn't given this one to return to.
      setOverlay((cur) => cur?.back ?? null);
      // An action waiting for the viewer to close (showText(..., { onClosed })) carries on.
      closing?.onClosed?.();
    },
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    // On the section for the view on screen.
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(customRef.current.sections, view) }),
    // Your own command `cmd` (usercommands.js) with what was typed after it, and any line as typed at
    // the prompt; both resolve false when it failed.
    runUserCommand: (cmd, rest) => runUserCommand(cmd, rest),
    runLine: (text) => runLine(text),
    openPalette: () => openPalette(),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
    // `paths` limits it to some files (a file's history: its path then, and the one before a rename).
    showPatch: (c, paths = []) =>
      showAsync(`${c.hash.slice(0, 7)} ${c.subject}${paths.length ? ` · ${paths.at(-1)}` : ''}`, () => commitPatch(dataRef.current.root, c.hash, paths), { diff: true }),
    showChange: (f) => {
      const owners = ownersLine(ownersOf(dataRef.current.codeowners, f.path).owners);
      showAsync(`${f.path} (${f.area})${owners ? ` · ${owners}` : ''}`, () => changeDiff(dataRef.current.root, f), { diff: true });
    },
    // The diff with its review comments, when the host can list them; a diff without them if that fails.
    showPrDiff: (pr) => {
      const host = ctx.host();
      showAsync(`${pr.label} ${pr.title}`, () => host.diff(pr), { diff: true, pr });
      ctx.refreshThreads(pr);
    },
    // Fetches a pull request's review threads into its diff, if that's still what the viewer shows.
    refreshThreads: (pr) =>
      ctx
        .host()
        ?.threads?.(pr)
        .then(
          (threads) => setOverlay((o) => (o?.pr === pr ? { ...o, threads } : o)),
          () => {},
        ),
    // What `ref` adds to `base`: the diff from where they forked (three dots), as a pull request would show it.
    showCompare: (ref, base) =>
      showAsync(
        `${base}...${ref}`,
        async () => (await git(dataRef.current.root, ['diff', '--stat', '--patch', '-M', `${base}...${ref}`, '--'])) || `${ref} has no changes that ${base} doesn't.`,
        { diff: true },
      ),
    showStash: (s) => showAsync(`${s.ref} ${s.message}`, () => stashPatch(dataRef.current.root, s.ref), { diff: true }),
    showStashFile: (s, file) => showAsync(`${file.path} in ${s.ref}`, () => stashFileDiff(dataRef.current.root, s.ref, file), { diff: true }),
  });

  // One line as typed at the prompt: git after ! (or starting with git), else a slash command.
  // Resolves false when it failed: it threw, said an error, or a question it asked was answered no
  // (so your own commands stop there).
  const runLine = async (text) => {
    const [errors, declined] = [errorCount.current, declines.current];
    try {
      let r;
      // A context another app copied (family.js), pasted without its /take (after the prompt's / or not).
      if (decodeContext(text.replace(/^\//, ''))) r = await a.take(ctx, text.replace(/^\//, ''));
      else if (text.startsWith('!')) r = await a.raw(ctx, text.slice(1));
      else if (/^git(\s|$)/.test(text)) r = await a.raw(ctx, text);
      else {
        const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
        const cmd = findCommand(name, customRef.current.commands);
        if (!cmd) {
          note(`Unknown command: /${name}. Type / to see them all.`, 'error');
          return false;
        }
        r = await cmd.run(ctx, rest.trim());
      }
      return r !== false && r?.ok !== false && errorCount.current === errors && declines.current === declined;
    } catch (e) {
      note(firstLine(e.message), 'error');
      return false;
    }
  };

  // One of your own commands: its lines in order, with what was typed after it filled in, stopping at
  // the first that fails. Commands of yours may run each other, but not round in a circle.
  const userDepth = useRef(0);
  const runUserCommand = async (cmd, rest) => {
    if (userDepth.current >= 5) {
      note(`/${cmd.name}: your commands run each other round in a circle, so it stopped.`, 'error');
      return false;
    }
    const lines = expandLines(cmd, rest);
    userDepth.current++;
    try {
      for (const [i, line] of lines.entries()) {
        if (await runLine(line)) continue;
        if (i < lines.length - 1) note(`/${cmd.name} stopped at ${line}: the ${plural(lines.length - i - 1, 'line')} after it didn't run.`, 'error');
        return false;
      }
      return true;
    } finally {
      userDepth.current--;
    }
  };

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    await runLine(text);
  };

  // ctrl+p: the palette, over the view, starting from what's typed in the prompt when it's open there.
  const openPalette = () => {
    const typed = focusRef.current === 'prompt' ? promptRef.current.value.trim() : '';
    if (focusRef.current === 'prompt') setFocus('view');
    setOverlay({ kind: 'palette', query: typed.startsWith('!') ? '' : typed.replace(/^\//, '') });
  };
  // What's picked in it: a key goes to the view, a command runs, or waits in the prompt for what it
  // takes. After every handler has had the ↵ that picked it, so it isn't also the prompt's.
  const runPicked = (it) =>
    queueMicrotask(() => {
      ctx.closeOverlay();
      if (it.key) pendingKey.current = it.key.seq;
      else if (it.ask) prefill(`${it.command} `);
      else runLine(it.command);
    });

  // Your keys, where they come in: while a view has the keys (never while typing, in a confirm or
  // over an overlay), a key you mapped becomes the key it stands for, for the view and App alike, or
  // runs its command line. Then ctrl+p opens the palette, from a view or the prompt.
  const sendKey = useKeyTranslation((input) => {
    // A paste in a view (or over a list or the viewer, but not into a search being typed there) that is a
    // command line or a context another app copied: into the prompt, to look at before running it. A
    // dropped path is a drop (globalKeys), not this, and a path that isn't there just typing, as before.
    const o = overlayRef.current;
    if (focusRef.current === 'view' && !confirmRef.current && (!o || o.kind === 'picker' || (!o.kind && !ctx.viewerTyping?.()))) {
      // (A terminal ends a pasted line with \r, which the family's rule takes as a \n.)
      const line = pastedLine(input);
      // An absolute path (Linux and macOS ones start with /) is a drop, or typing, unless it names a command.
      const command = /^\/([^\s/]+)(\s|$)/.exec(line ?? '')?.[1];
      if (line && !(droppedPaths(line) && !(command && findCommand(command, customRef.current.commands)))) {
        prefill(line);
        return null;
      }
    }
    let out = input;
    if (focusRef.current === 'view' && !overlayRef.current && !confirmRef.current) {
      const b = translateKey(customRef.current.keymap, viewRef.current, input);
      if (b?.command) {
        queueMicrotask(() => runLine(b.command));
        return null;
      }
      if (b?.key) out = b.key.seq;
    }
    if (out === CTRL_P && !overlayRef.current && !confirmRef.current && (focusRef.current === 'view' || focusRef.current === 'prompt')) {
      openPalette();
      return null;
    }
    return out;
  });
  useEffect(() => {
    if (pendingKey.current == null || overlayRef.current) return;
    const k = pendingKey.current;
    pendingKey.current = null;
    sendKey(k);
  });

  // First load: the given folder if it's a repo. Otherwise, when Splice was started without a path, the
  // repository open last time (the most recent one still there); failing that, the repo picker scanning that folder.
  useEffect(() => {
    if (custom.problems.length) {
      const text = ['Some of your commands or keys in the config were left out:', ...custom.problems].join('\n');
      note(text, 'error');
      lastOutput.current = { title: 'Your commands and keys', text };
    }
    (async () => {
      const here = await openRepo(initialPath, { silent: true });
      let reopened = null;
      if (!here && reopenLast) {
        for (const path of configRef.current.recent.filter((r) => existsSync(r)).slice(0, 3)) {
          if (await openRepo(path, { silent: true })) {
            reopened = path;
            break;
          }
        }
      }
      setLoading(false);
      if (reopened) {
        note(`Opened ${basename(reopened)}, the repository you had open last (${basename(resolve(initialPath))} isn't one). Repos lists the others.`);
      } else if (!here) {
        setView('repos');
        // By its name: the Repos view's "Scanning" line has the whole path.
        note(`${basename(resolve(initialPath))} isn't inside a git repository. Pick one below, or /open <path>.`);
      }
      // Opening a repo only needs the paths (for /open completion); the Repos view fills in the rest when shown.
      refreshRepos(here ? [] : [initialPath], { summaries: !here && !reopened });
      // After the first load, so it doesn't slow it down. cli.jsx passes the check and the install; tests
      // leave them out or pass stubs, so they stay offline and never replace anything.
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Splice ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Splice ${checked.latest} is installed. It starts the next time you open Splice.`);
              },
              (e) => {
                setUpdate({ ...checked, state: 'out' });
                outNote(`, but it couldn't be installed: ${firstLine(e.message)}`);
              },
            );
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

  // Tracked files for completing paths (/history, /blame): listed the first time they're asked
  // for, and again only once the repository has changed since.
  const [files, setFiles] = useState(null);
  const filesFor = useRef(null);
  const wantFiles = focus === 'prompt' && data && completionKind(prompt.value) === 'files';
  useEffect(() => {
    if (!wantFiles) return;
    const key = `${data.root}\n${data.signature}`;
    if (filesFor.current === key) return;
    // Another repository's files aren't worth showing while these load.
    if (!filesFor.current?.startsWith(`${data.root}\n`)) setFiles(null);
    filesFor.current = key;
    git(data.root, ['ls-files', '-z']).then(
      (out) => filesFor.current === key && setFiles(out.split('\0').filter(Boolean)),
      () => filesFor.current === key && setFiles([]),
    );
  }, [wantFiles, data]);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = windowTitle(data);
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  // Notice changes made outside Splice (an editor saving, a commit from another terminal).
  useEffect(() => {
    const t = setInterval(async () => {
      const repo = repoRef.current;
      if (!repo || !dataRef.current || busyRef.current || polling.current) return;
      polling.current = true;
      try {
        const snap = await snapshot(repo);
        if (repoRef.current === repo && dataRef.current && snap.signature !== dataRef.current.signature) await reload({ freshRefs: snap.relisted });
      } catch {
        // The repo may be mid-operation or gone; the next tick tries again.
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, repos, files: files ?? [], user: custom.commands }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataRef.current, repos, files: files ?? [], user: customRef.current.commands });
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
      else if (reaction) setReaction(null);
      else if (!filter || view !== 'graph') {
        setEntries([]);
        setWelcome(false);
      }
      return;
    }
    // A folder or file dropped on the terminal (which types its path): a repository to open, or a file's history.
    if (input.length > 1 && a.openDropped(ctx, input)) return;
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return a.settings(ctx);
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
    if (input === 'z') return a.undo(ctx);
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    // Ink calls the handlers for a key in no fixed order. When a view's ran first and opened the prompt
    // (c in Changes prefills "/commit "), this same key mustn't then be typed into it.
    if (focusRef.current === 'prompt' && !confirmRef.current) return prefillKey.current === keySeq.current ? undefined : promptKeys(input, key);
    if (key.ctrl && input === 'c') return exit();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    globalKeys(input, key);
  });

  // The terminal reports the mouse while the setting is on (it is unless set off).
  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
  // The component under a point of the main area (`y` counted from its top), and that `y` in it.
  const mouseTarget = (y) => {
    const target = ctx.mouseHandlers.findLast((h) => h.top <= y);
    return target && { target, y: y - target.top };
  };
  const onMouse = (e) => {
    if (e.type === 'copy') {
      const n = e.text.split('\n').length;
      return setFlash({ text: n > 1 ? `Copied ${n} lines` : `Copied ${e.text.length} character${e.text.length === 1 ? '' : 's'}` });
    }
    if (e.button === 'left' && !e.release && !e.drag) {
      const prev = lastPress.current;
      const now = Date.now();
      const count = prev && prev.x === e.x && prev.y === e.y && now - prev.at < DOUBLE_CLICK_MS ? prev.count + 1 : 1;
      e.double = count === 2;
      e.triple = count === 3;
      // A fourth click starts over rather than counting on.
      lastPress.current = count < 3 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (!e.drag && e.button !== 'wheel') return;
    // A confirmation's options are picked with keys.
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.drag) {
      // A drag the component it started in takes itself (claimDrags below; useMouse's `drags`).
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      // Whatever is open over the view closes: a click on a tab should never do nothing.
      for (let n = 0; overlayRef.current && n < 20; n++) ctx.closeOverlay();
      setFocus('view');
      return setView(tab.id);
    }
    if (e.y >= mainTop && e.y < mainTop + mainH) {
      // Like esc, a click on the view leaves the prompt's text for later.
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y >= promptTop && e.y < promptTop + 3) {
      // The text starts after the border, the padding and "> ", scrolled as PromptBox scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = columns - 6;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 4)));
      return setFocus('prompt');
    }
    const sug = e.y - promptTop - 3;
    if (sug >= 0 && sug < sugCount) {
      setSugIndex(sug);
      // As ↵ would, on the suggestion under the pointer.
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  // Drags that start where the component on screen selects for itself skip the screen selection.
  useEffect(
    () =>
      mouse?.claimDrags?.((e) => {
        const at = layout.current;
        if (confirmRef.current || !at || e.y < at.mainTop || e.y >= at.mainTop + at.mainH) return false;
        const hit = mouseTarget(e.y - at.mainTop);
        return Boolean(hit?.target.drags?.({ ...e, y: hit.y }));
      }),
    [mouse],
  );

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  const act = activityRows(entries);
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ data, busy, lastEntry: entries.at(-1) });
  // Twig's mood for the family (family.js), written whenever it changes, and the others' read every half
  // a minute: a worried, sad or happy one from the last 15 minutes gets a line, once. "Family moods" in
  // /settings turns both off.
  const moodsOn = Boolean(familyHome) && config.familyMoods !== false;
  const shared = familyMood(mood, { data, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (moodsOn) writeMood('splice', shared, { dir: familyHome });
  }, [moodsOn, shared.mood, shared.reason]);
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (!moodsOn) return void setReaction(null);
    const look = () => {
      const fresh = moodsToShow(readMoods('splice', { dir: familyHome }), seenMoods.current);
      for (const m of fresh) seenMoods.current.add(`${m.app}:${m.at}`);
      if (fresh[0]) setReaction({ text: reactionText(fresh[0]), mood: fresh[0].mood });
    };
    look();
    const t = setInterval(look, moodEvery);
    t.unref?.();
    return () => clearInterval(t);
  }, [moodsOn, familyHome, moodEvery]);
  const reactionH = reaction ? 1 : 0;
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - reactionH - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + reactionH + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(data),
  };

  // The palette's list: this view's keys, yours, then the commands.
  const paletteList = useMemo(
    () => paletteItems({ commands: COMMANDS, user: custom.commands, sections: HELP.filter((s) => s.title === 'Anywhere' || s.views?.includes(view)), keymap: custom.keymap, view, skip: ['ctrl+p'] }),
    [custom, view],
  );

  let main;
  if (overlay?.kind === 'palette') {
    // Closed once every handler has had the esc, or App's would also take it (and clear the log).
    main = <Palette items={paletteList} query={overlay.query} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onPick={runPicked} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'rebase') {
    main = <RebaseEditor plan={overlay.plan} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay?.kind === 'help') {
    main = <HelpView sections={custom.sections} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (overlay?.kind === 'picker') {
    main = <Picker key={overlay.id} picker={overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (view === 'repos') {
    main = <ReposView repos={repos} roots={[...config.roots, ...extraRoots.current]} current={data?.root} progress={fetchProgress} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!data) {
    main = (
      <Panel title={VIEWS.find((v) => v.id === view).label} width={W} height={mainH}>
        <Text color={theme.dim}>{loading ? '  Loading…' : '  No repository open. Press 7 to pick one, or /open <path>.'}</Text>
      </Panel>
    );
  } else {
    const View = { graph: GraphView, changes: ChangesView, branches: BranchesView, stash: StashView, prs: PrView, worktrees: WorktreesView }[view];
    main = <View data={data} ctx={ctx} width={W} height={mainH} active={viewActive} filter={filter} prVersion={prVersion} jump={jump} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'rebase'
        ? '↵ start the rebase · esc cancel'
        : overlay?.kind === 'help'
          ? 'j/k section · space scroll · / search · esc close'
          : overlay?.kind === 'palette'
          ? 'type to filter · ↑↓ pick · ↵ run it (a key in the view; a command that takes more goes into the prompt) · esc close'
          : overlay?.kind === 'picker'
          ? 'j/k move · esc close'
          : overlay
          ? 'j/k scroll · space page · n/N hunk · / search · esc close'
          : HINTS[view];
  const right = focus === 'prompt' ? '' : '  f fetch · p pull · P push · z undo · / commands · ! git · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} width={W} loading={loading} mood={mood} />
      <Tabs view={view} data={data} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={data} width={W} update={update} /> : null}
      {reaction ? (
        <Row
          pointer={false}
          width={W}
          segments={[{ text: `${FACES[reaction.mood === 'happy' ? 'happy' : 'worried']} `, color: theme.accent, bold: true }, { text: reaction.text }, { text: '  · esc puts it away', color: theme.dim }]}
        />
      ) : null}
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
