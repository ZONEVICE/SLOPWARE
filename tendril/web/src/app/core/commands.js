/**
 * Commands and keyboard shortcuts.
 *
 * Every action of the editor is a command: `{ id, title, category, icon,
 * keys, run, when, checked, native, terminal }`. Menus, the toolbar, the
 * command palette and the keyboard all trigger commands by id, so a feature
 * registers its commands once and shows up everywhere.
 *
 * Shortcut strings look like "Ctrl+Shift+P", "Alt+Z", "F1". "Mod" means Cmd
 * on macOS and Ctrl elsewhere. Keys are matched by physical key
 * (`KeyboardEvent.code`), like VS Code, so they work on any layout.
 *
 * - `native: true`: the shortcut belongs to the editor (undo, copy, find,
 *   multi-cursor...). It is shown in menus but the key itself is left to the
 *   focused control; menus, the toolbar and the palette still run it.
 * - `terminal: true`: the shortcut also works while the terminal has focus;
 *   every other key goes to the shell.
 */
import { isMac } from './dom.js';

/** `KeyboardEvent.code` -> the key name used in shortcut strings. */
function keyName(code, key) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /\d$/.test(code)) return code.slice(6);
  const map = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter',
  };
  if (map[code]) return map[code];
  return code || key;
}

/** Normalised shortcut string for a keydown event. */
export function eventShortcut(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(keyName(event.code, event.key));
  return parts.join('+');
}

/** Normalises "Mod+Shift+p" to the canonical event form. */
export function normalizeShortcut(spec) {
  const parts = spec.split('+').map((p) => p.trim());
  const key = parts.pop();
  const mods = new Set(parts.map((p) => (p === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : p === 'Cmd' ? 'Meta' : p)));
  const order = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter((m) => mods.has(m));
  return [...order, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** How a shortcut is shown in menus and tooltips. */
export function displayShortcut(spec) {
  if (!spec) return '';
  const canonical = normalizeShortcut(spec);
  if (!isMac) return canonical;
  return canonical.replace('Meta+', '⌘').replace('Ctrl+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧');
}

function isTextField(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type);
  return false;
}

/** Creates the registry. `app` is passed to `run` and `when`. */
export function createCommands(app) {
  const commands = new Map();
  const bindings = new Map();

  const registry = {
    /** Registers a command (replacing one with the same id). */
    register(command) {
      commands.set(command.id, command);
      for (const spec of [].concat(command.keys || [])) bindings.set(normalizeShortcut(spec), command.id);
      return command;
    },

    get: (id) => commands.get(id),

    all: () => [...commands.values()],

    enabled(id) {
      const command = commands.get(id);
      return !!command && (!command.when || !!command.when(app));
    },

    checked(id) {
      const command = commands.get(id);
      return !!command?.checked && !!command.checked(app);
    },

    /** Runs a command if it exists and is enabled. */
    async run(id, ...args) {
      const command = commands.get(id);
      if (!command || (command.when && !command.when(app))) return undefined;
      try {
        const result = await command.run(app, ...args);
        app.bus?.emit('command:ran', id);
        return result;
      } catch (err) {
        console.error(`[command] ${id} failed`, err);
        app.ui?.toast?.error(err.message || String(err));
        return undefined;
      }
    },

    /** The primary shortcut of a command, for display. */
    shortcut(id) {
      const keys = commands.get(id)?.keys;
      return displayShortcut(Array.isArray(keys) ? keys[0] : keys);
    },

    /** Handles a keydown; returns true when a command consumed it. */
    handleKey(event) {
      if (event.isComposing || event.key === 'Dead') return false;
      const id = bindings.get(eventShortcut(event));
      if (!id) return false;
      const command = commands.get(id);
      if (command.native) return false;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      const inTerminal = !!target?.closest?.('.terminal-host');
      if (inTerminal && !command.terminal) return false;
      // Plain keys (F2, Delete...) never fire while typing in a field.
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d+$/.test(event.code) && isTextField(target)) return false;
      if (command.when && !command.when(app)) return false;
      event.preventDefault();
      event.stopPropagation();
      registry.run(id);
      return true;
    },
  };
  return registry;
}
