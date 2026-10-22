// The /settings list: every setting, its value and what ↵ does with it. Pure, so the list is tested
// without the UI; actions.js shows it in a picker and makes the changes.
import { DEFAULT_ACCENT, LIGHT_ACCENT, THEMES, theme } from './theme.js';
import { fit } from './text.js';
import { notifySeconds } from './notify.js';
import { SPLIT_WIDTH } from './split.js';

const isOn = (value) => value !== false;
const defaultAccent = () => (theme.mode === 'light' ? LIGHT_ACCENT : DEFAULT_ACCENT);

/** The Theme setting: dark, light, or auto (the default: COLORFGBG says, else dark). */
export const themeSetting = (config) => (THEMES.includes(config.theme) ? config.theme : 'auto');

/** What ↵ on the Theme row changes it to: dark, light, auto, round again. */
export const nextTheme = (config) => THEMES[(THEMES.indexOf(themeSetting(config)) + 1) % THEMES.length];
const count = (n, one, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : 'none');

/**
 * The rows, from the config: { id, label, value, note, action }, where `action` is what ↵ does:
 * 'toggle' (an on/off setting named `id`, on unless set false, or off unless set true where `off`), 'accent', 'theme', 'roots', 'cleanupKeep', 'clear' (the list named `id`) or 'none'.
 * `mouse`: whether this terminal can report the mouse at all.
 */
export function settingRows(config, { file = '', mouse = true } = {}) {
  const roots = config.roots ?? [];
  const recent = config.recent ?? [];
  const history = config.history ?? [];
  const keep = config.cleanupKeep ?? [];
  const checks = isOn(config.checkForUpdates);
  return [
    { id: 'accent', label: 'Accent colour', value: config.accent ?? `${defaultAccent()} (default)`, colour: config.accent ?? defaultAccent(), note: 'type a new one', action: 'accent' },
    {
      id: 'theme',
      label: 'Theme',
      value: themeSetting(config) === 'auto' ? `auto (${theme.mode} here)` : themeSetting(config),
      note: `${nextTheme(config)} next${themeSetting(config) === 'light' ? ': from the terminal, else dark' : ''}`,
      action: 'theme',
    },
    {
      id: 'mouse',
      label: 'Mouse',
      value: isOn(config.mouse) ? 'on' : 'off',
      note: !mouse ? "this terminal can't report it" : isOn(config.mouse) ? 'off leaves selecting to the terminal' : 'click, scroll, drag to copy',
      action: 'toggle',
    },
    { id: 'checkForUpdates', label: 'Check for new versions', value: checks ? 'on' : 'off', note: 'once a day, in the downloaded Splice', action: 'toggle' },
    {
      id: 'autoUpdate',
      label: 'Install them by itself',
      value: isOn(config.autoUpdate) ? 'on' : 'off',
      note: checks ? 'they start the next time you open Splice' : 'only while checking is on',
      action: 'toggle',
    },
    {
      id: 'stashUntracked',
      label: 'Stash untracked files',
      value: isOn(config.stashUntracked) ? 'on' : 'off',
      note: isOn(config.stashUntracked) ? 's and /stash take new files too (/stash --no-untracked)' : 'only changes to tracked files (/stash -u)',
      action: 'toggle',
    },
    {
      id: 'notify',
      label: 'Notify when done',
      value: isOn(config.notify) ? 'on' : 'off',
      note: isOn(config.notify) ? `a bell and a notification after ${notifySeconds(config)} s, and for your PRs` : 'say nothing when a long command ends',
      action: 'toggle',
    },
    {
      id: 'sideBySide',
      label: 'Side-by-side diffs',
      value: config.sideBySide === true ? 'on' : 'off',
      note: config.sideBySide === true ? 'one column again (w in a diff)' : `old and new in two columns, ${SPLIT_WIDTH}+ wide (w in a diff)`,
      action: 'toggle',
      off: true,
    },
    {
      id: 'checkBeforePush',
      label: 'Check before pushing',
      value: isOn(config.checkBeforePush) ? 'on' : 'off',
      note: isOn(config.checkBeforePush) ? 'asks first when the commits have files over 50 MB or what look like secrets' : 'push without looking at the commits first',
      action: 'toggle',
    },
    {
      id: 'cleanupKeep',
      label: 'Keep on the remote',
      value: keep.length ? keep.join(', ') : 'none',
      note: 'branches /cleanup never deletes there',
      action: 'cleanupKeep',
    },
    { id: 'roots', label: 'Folders to scan', value: count(roots.length, 'folder'), note: 'see them, add or remove', action: 'roots' },
    { id: 'recent', label: 'Recent repositories', value: count(recent.length, 'repository', 'repositories'), note: recent.length ? 'forget them' : '', action: recent.length ? 'clear' : 'none' },
    { id: 'history', label: 'Prompt history', value: count(history.length, 'entry', 'entries'), note: history.length ? 'clear it' : '', action: history.length ? 'clear' : 'none' },
    { id: 'file', label: 'Settings file', value: file, note: '', action: 'none' },
  ];
}

/** A row as segments: the label, the value (on in green, the accent in its own colour), and what ↵ does. */
export function settingSegments(row) {
  const value =
    row.id === 'accent'
      ? [{ text: '■ ', color: row.colour }, { text: fit(row.value, 26), color: row.colour }]
      : [{ text: fit(row.value, 28), color: row.value === 'on' ? theme.add : row.value === 'off' || row.value === 'none' ? theme.dim : undefined }];
  return [{ text: fit(row.label, 28), strong: true }, ...value, { text: row.note ? `  ↵ ${row.note}` : '', color: theme.dim }];
}
