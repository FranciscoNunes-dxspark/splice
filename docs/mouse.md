# Mouse support (future feature)

Status in Splice: **done** (`src/mouse.js`, `src/selection.js`). Selection is linear only (no block selection with alt), and copying is always on release (no `copyOnSelect` setting).

Windows, checked 2026-10-20 in Windows Terminal: the console only hands mouse reports over as text in VT input mode (`ENABLE_VIRTUAL_TERMINAL_INPUT`, 0x200); otherwise they arrive as console mouse records, which libuv drops. Node 22.17 and later turn that mode on with raw mode (`UV_TTY_MODE_RAW_VT`); Node 22.13 doesn't. The compiled builds set it themselves through `bun:ffi` after every switch to raw mode (whether Bun 1.4.2's raw mode already does is unchecked; setting it again is harmless). Older Node on Windows gets no mouse.

 A design shared by the three Ink terminal apps: **Splice** (git), **Trawl** (SQL Server) and **Keel** (Azure DevOps). They're built the same way (Ink 6.8, React 19, plain JS, Bun-compiled executables, a `ui/` folder with `hooks.js`, `parts.jsx` and an `App.jsx` that builds `ctx`), so one implementation can be copied between them. Paths below are relative to each app's UI root: `src/` in Splice and Trawl, `cli/` in Keel.

## The goal

- Click a tab, a list row, a pane or the prompt; double-click does what `↵` does; the wheel scrolls what's under the pointer.
- **Without losing text selection.** Drag to select and copy must keep working the way people expect.

## Why it isn't simple

Ink has no mouse support. The terminal only reports the mouse if the app asks (mouse reporting modes), and **as soon as an app asks, the terminal stops doing its own drag-to-select**, because the drag goes to the app. Shift+drag still selects natively in most terminals, but few people know that.

## How Claude Code does it

Claude Code (also an Ink-style React terminal app) has clicks *and* selection. Reading its bundled code shows it **doesn't keep the terminal's selection; it reimplements it**:

1. It turns mouse reporting on (its renderer knows tracking modes `normal`, `button`, `any`; `button` reports drags).
2. A selection store tracks the drag (`isDragging`, `hasSelection()`) in screen cells.
3. It paints the selection itself, with a theme colour (`selectionBg`).
4. On release it copies the selected text from its own model of the screen to the clipboard: OSC 52 (an escape sequence asking the terminal to set the clipboard) or the system clipboard. Setting `copyOnSelect`, on by default.
5. When copying fails it shows a hint: hold a modifier (Shift) while selecting for the terminal's native copy.

Claude Code has its own renderer with a cell grid of what's on screen, which makes 3 and 4 easy. Stock Ink doesn't, so we have to rebuild that grid ourselves (see "Selection and copy").

## Design

Five pieces. 1 to 4 give clicks and the wheel; 5 gives selection back.

### 1. Terminal modes (`cli.jsx`)

```js
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'; // button events + drags, SGR encoding
const MOUSE_OFF = '\x1b[?1002l\x1b[?1006l';
```

- `?1000h` would be clicks and the wheel only; `?1002h` adds drags (needed for selection). `?1006h` is the SGR encoding: `ESC [ < b ; x ; y M` (press) or `m` (release), with no 223-column limit.
- Write `MOUSE_OFF` in the same `process.on('exit')` handler that leaves the alternate screen, so a crash or `q` never leaves the terminal reporting the mouse.
- A config switch, `"mouse": false`, for people who prefer the terminal's own selection.

### 2. Taking mouse input away from Ink (`mouse.js`, identical in the three apps)

Ink reads stdin in raw mode (`stdin.read()` in a `readable` handler) and would turn mouse sequences into junk key presses (a stray `ESC` would even cancel the running command). Wrap `stdin.read` before rendering, strip the sequences out and hand them to a listener:

```js
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Splits input into what's left for Ink and the mouse events in it (x, y 0-based). */
export function parseMouse(chunk) {
  const events = [];
  const rest = chunk.replace(SGR, (_, b, x, y, end) => {
    const code = Number(b);
    const e = { x: Number(x) - 1, y: Number(y) - 1, release: end === 'm', drag: Boolean(code & 32),
      shift: Boolean(code & 4), alt: Boolean(code & 8), ctrl: Boolean(code & 16) };
    if (code & 64) Object.assign(e, { button: 'wheel', wheel: code & 1 ? 1 : -1 });
    else e.button = ['left', 'middle', 'right', 'none'][code & 3];
    events.push(e);
    return '';
  });
  return { rest, events };
}

/** Takes mouse sequences out of what Ink reads and calls onMouse with each. Returns an undo. */
export function listenMouse(stdin, onMouse) {
  const read = stdin.read;
  let held = ''; // a sequence cut in two by a read boundary waits here for its end
  stdin.read = function (...args) {
    let chunk = read.apply(this, args);
    if (typeof chunk !== 'string') return chunk;
    chunk = held + chunk;
    held = '';
    if (!chunk.includes('\x1b[<')) return chunk;
    const { rest, events } = parseMouse(chunk);
    events.forEach(onMouse);
    const cut = /\x1b\[<[\d;]*$/.exec(rest);
    if (!cut) return rest;
    held = cut[0];
    return rest.slice(0, cut.index);
  };
  return () => { stdin.read = read; };
}
```

Ink calls `setEncoding('utf8')`, so chunks are strings, and an empty string after stripping produces no key events (checked against Ink 6.8's input parser).

`cli.jsx` passes `App` a `mouse` prop: a subscribe function `(fn) => unsubscribe`. That follows the pattern already used for `checkUpdate`/`askClaude`: **tests pass their own `mouse` and emit synthetic events**, and never touch a real terminal.

### 3. Routing events (`App.jsx`, `hooks.js`)

- `App` keeps the layout it just rendered in a ref (`{ mainTop, mainH, promptTop }`: the header and tab rows are fixed, the main area's height is computed, the prompt sits below the activity lines), and hit-tests:
  - the tab row → switch view (close an overlay first: a click on a tab should never do nothing);
  - the prompt box → focus the prompt;
  - the main area → focus the view (keeping the prompt's text, like `esc`) and pass the event on with `y` relative to the main area.
- Double-click: two left presses on the same cell within 400 ms set `e.double`.
- While a confirmation is open, swallow everything (its options are keys; clicking them can come later).
- `hooks.js` gets `MouseContext` plus `useMouse(handler)`: the view on screen subscribes; App's provider hands it events.
- `useListNav` gets `pick(row)` (put the cursor on the visible row `row` if it's selectable, return whether it did) and `scrollBy(n)`. `scrollBy` must start from a ref holding the latest index, not from the render's `i`, because wheel notches arrive faster than renders.

### 4. Views

Each view knows its own geometry (`split`, `listW`, rows start one line under the panel's top border, plus any header rows such as Splice's Repos "Scanning…" line):

```js
const keys = (input, key) => { /* the existing useInput handler, now named */ };
useInput(keys, { isActive: active });
useMouse((e) => {
  if (e.x >= listW) return e.wheel && scrollDetail(e.wheel * 3);   // right-hand pane
  if (e.wheel) return nav.scrollBy(e.wheel * 3);
  if (nav.pick(e.y - 1) && e.double) keys('', { return: true });   // double-click = ↵
});
```

Naming the `useInput` handler `keys` is what lets a double-click reuse `↵` without duplicating its logic. Where `↵` starts something big (Splice's rebase editor), clicks only select.

Per app:

| App | Main candidates |
| --- | --- |
| Splice (`src/ui`) | Tabs; Graph, Changes (files and diff panes; click in the diff focuses it), Branches, Worktrees, Stash, PRs, Repos lists; wheel in the viewer and the commit detail pane. |
| Trawl (`src/ui`) | Tabs; Connections, Explorer and History lists; Results grid (click a cell, wheel scrolls rows, shift+wheel scrolls columns); Query editor (click places the cursor, which needs the editor's text-to-screen mapping). |
| Keel (`cli/ui`) | Tabs; Inbox, PRs and Pipelines lists; double-click opens like `↵`. |

### 5. Selection and copy (what keeps "select" working)

Mirror Claude Code:

1. **A screen model.** Render Ink into a wrapping stdout (`render(<App/>, { stdout: wrapped })`) that forwards writes to the real stdout and keeps the last full frame as plain text: strip ANSI, split into lines, and map columns with `string-width` (wide characters take two cells). Check first whether Ink writes whole frames or only the changed lines (unverified for 6.8); with partial writes, the model has to apply them to the previous frame.
2. **Drag tracking.** Press records the anchor cell; `drag` events extend it; release ends it. A press without a drag is a click (pieces 3 and 4). Hold drags back from the views.
3. **Highlight.** After each frame is written, paint the selected cells again in reverse video by writing straight to the terminal (save cursor, move to each row, `\x1b[7m` + text + `\x1b[27m`, restore cursor). Ink redraws whenever state changes, so repaint after every write while a selection exists, and clear the selection on the next key press or click.
4. **Copy on release.** Take the text from the model (rows joined with newlines, trailing spaces trimmed) and set the clipboard with OSC 52, `\x1b]52;c;${base64}\x07`, which Windows Terminal, iTerm2, kitty, WezTerm and VS Code's terminal support (tmux needs `set -g set-clipboard on`). Fall back to `clip.exe` (Windows), `pbcopy` (macOS) or `wl-copy`/`xclip` (Linux) as a child process. Say so in the activity line: `Copied 3 lines`, plus "hold Shift while dragging to use the terminal's own selection" if neither route worked.
5. Respect `"mouse": false`, and consider `"copyOnSelect": false` (select, then `y` or `ctrl+c` copies) like Claude Code's setting.

## Open questions and risks

- **Windows input (check this first).** On Windows, Node's raw-mode stdin goes through libuv, which may translate console input records into key sequences and drop mouse records. Whether SGR mouse sequences reach `stdin.read()` under Node 22, and under the Bun-compiled executables, is unverified. Probe before building anything:

  ```js
  // probe.js: run it in Windows Terminal, click and scroll, then press q.
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?1002h\x1b[?1006h');
  process.stdin.on('data', (d) => {
    if (d === 'q') { process.stdout.write('\x1b[?1002l\x1b[?1006l'); process.exit(); }
    console.log(JSON.stringify(d));
  });
  ```

  Run it with `node probe.js` and with a Bun-compiled build of it. If no `\u001b[<…M` shows up on Windows, mouse support there needs a different input path (or isn't possible with this stack), and only macOS and Linux get it.
- Terminals differ: conhost (the old Windows console) and some SSH setups don't report SGR mouse; tmux and screen must have mouse passthrough enabled.
- Painting the highlight outside Ink can flicker on slow terminals; measure before polishing.
- Accessibility: everything must stay reachable by keyboard; the mouse is a shortcut, never the only way.

## Testing

- `parseMouse` / `listenMouse`: unit tests (whole sequences, several in one chunk, a sequence split across two reads, wheel, drag and modifier bits, keys mixed in).
- Views: end-to-end with `ink-testing-library`, passing a `mouse` prop and emitting events; assert the cursor, focus and view changes in `lastFrame()`.
- Selection: unit-test the screen model (ANSI stripping, wide characters, cell ranges to text) separately from the painting.

## Order of work

1. Run the Windows probe (decides the scope).
2. `mouse.js` + terminal modes + config switch + wheel scrolling (small, immediately useful).
3. Clicks: tabs, list rows, panes, prompt, double-click.
4. Selection and copy.
5. Port to the other two apps: copy `mouse.js` as is, then wire each app's `App.jsx`, `hooks.js` and views per the table above.

A first version of pieces 1 to 4 was written for Splice (then still called Tiller) and dropped before testing (2026-10-20); the code above is that version, cleaned up.
