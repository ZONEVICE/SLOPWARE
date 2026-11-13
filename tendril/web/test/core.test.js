/**
 * Unit tests for the front end's pure modules (no DOM needed), run with the
 * built-in runner:  npm --prefix web test   (or: node --test web/test/)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createBus } from '../src/app/core/bus.js';
import { createCommands, displayShortcut, eventShortcut, normalizeShortcut } from '../src/app/core/commands.js';
import { bytes, duration } from '../src/app/core/format.js';
import { fuzzyFilter, fuzzyMatch } from '../src/app/core/fuzzy.js';
import { detectIndent } from '../src/app/core/indent.js';
import { fileIcon, languageFor, viewerFor } from '../src/app/core/languages.js';
import { basename, dirname, extname, isWithin, join, naturalCompare, rebase, resolve } from '../src/app/core/paths.js';
import { internals as markdown } from '../src/app/preview/markdown.js';
import { THEMES } from '../src/app/core/themes.js';

test('paths', () => {
  assert.equal(join('a', '', 'b/', './c'), 'a/b/c');
  assert.equal(join('', 'x'), 'x');
  assert.equal(dirname('a/b/c.txt'), 'a/b');
  assert.equal(dirname('c.txt'), '');
  assert.equal(basename('a/b/c.txt'), 'c.txt');
  assert.equal(extname('a/b/C.TXT'), 'txt');
  assert.equal(extname('.gitignore'), '');
  assert.equal(extname('Makefile'), '');
  assert.ok(isWithin('src', 'src/main.rs'));
  assert.ok(isWithin('src', 'src'));
  assert.ok(!isWithin('src', 'src2/main.rs'));
  assert.ok(isWithin('', 'anything'));
  assert.equal(rebase('src/a/b.rs', 'src/a', 'lib'), 'lib/b.rs');
  assert.equal(rebase('srcx/b.rs', 'src', 'lib'), 'srcx/b.rs');
  assert.deepEqual(['file10', 'file2', 'File1'].sort(naturalCompare), ['File1', 'file2', 'file10']);
  // Links in documents: relative to the folder, rooted at the workspace, never above it.
  assert.equal(resolve('docs/guide', '../img/a.png'), 'docs/img/a.png');
  assert.equal(resolve('docs', './b.md'), 'docs/b.md');
  assert.equal(resolve('docs', '/README.md'), 'README.md');
  assert.equal(resolve('', 'a/../b'), 'b');
  assert.equal(resolve('docs', '../../etc/passwd'), null);
});

test('the Markdown preview only keeps safe links and knows fence languages', () => {
  const { safeUrl, languageOfFence } = markdown;
  assert.equal(safeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeUrl('mailto:me@example.com'), 'mailto:me@example.com');
  assert.equal(safeUrl('docs/a.md#part'), 'docs/a.md#part');
  assert.equal(safeUrl('#anchor'), '#anchor');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(' JavaScript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<b>x</b>'), null);
  assert.equal(safeUrl('data:image/png;base64,AAAA', { image: true }), 'data:image/png;base64,AAAA');
  assert.equal(safeUrl('data:image/svg+xml;base64,AAAA', { image: true }), null);
  assert.equal(safeUrl('mailto:me@example.com', { image: true }), null);
  assert.equal(languageOfFence('js'), 'javascript');
  assert.equal(languageOfFence('bash'), 'shell');
  assert.equal(languageOfFence('Rust'), 'rust');
  assert.equal(languageOfFence('yml'), 'yaml');
  assert.equal(languageOfFence('no-such-language'), null);
});

test('fuzzy matching prefers file names and consecutive runs', () => {
  assert.equal(fuzzyMatch('xyz', 'src/main.rs'), null);
  const match = fuzzyMatch('mrs', 'src/main.rs');
  assert.ok(match);
  assert.deepEqual(match.positions, [4, 9, 10]);
  const ranked = fuzzyFilter('main', ['docs/maintenance/notes.md', 'src/main.rs', 'domain/index.js'], (p) => p);
  assert.equal(ranked[0].item, 'src/main.rs');
  assert.equal(fuzzyFilter('', ['a', 'b'], (p) => p).length, 2);
});

test('indentation detection', () => {
  assert.deepEqual(detectIndent('fn x() {\n\tlet a = 1;\n\tif a {\n\t\tb();\n\t}\n}\n'), { tabs: true, size: 4 });
  assert.deepEqual(detectIndent('a:\n  b:\n    c: 1\n  d: 2\n'), { tabs: false, size: 2 });
  assert.deepEqual(detectIndent('def f():\n    if x:\n        return 1\n    return 2\n'), { tabs: false, size: 4 });
  assert.deepEqual(detectIndent('', { tabs: false, size: 8 }), { tabs: false, size: 8 });
});

test('formatting', () => {
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(duration(45), '45s');
  assert.equal(duration(600), '10m');
  assert.equal(duration(3 * 3600 + 5 * 60), '3h 05m');
});

test('languages, viewers and icons', () => {
  assert.equal(languageFor('src/main.rs').id, 'rust');
  assert.equal(languageFor('web/App.TSX').id, 'tsx');
  assert.equal(languageFor('Dockerfile').id, 'dockerfile');
  assert.equal(languageFor('Dockerfile.prod').id, 'dockerfile');
  assert.equal(languageFor('.bashrc').id, 'shell');
  assert.equal(languageFor('Cargo.lock').id, 'toml');
  assert.equal(languageFor('notes.unknownext').id, 'plaintext');
  assert.equal(viewerFor('a/photo.JPG'), 'image');
  assert.equal(viewerFor('clip.webm'), 'video');
  assert.equal(viewerFor('song.flac'), 'audio');
  assert.equal(viewerFor('paper.pdf'), 'pdf');
  assert.equal(viewerFor('logo.svg'), null, 'SVG opens as text');
  assert.equal(fileIcon('logo.svg').icon, 'image');
  assert.equal(fileIcon('data.json').icon, 'json');
  assert.equal(fileIcon('archive.tar.gz').icon, 'archive');
});

test('shortcut parsing and display', () => {
  // Node reports a non-Mac platform on Linux/Windows CI.
  assert.equal(normalizeShortcut('Mod+Shift+p'), 'Ctrl+Shift+P');
  assert.equal(normalizeShortcut('Alt+Z'), 'Alt+Z');
  assert.equal(normalizeShortcut('F1'), 'F1');
  assert.equal(eventShortcut({ ctrlKey: true, shiftKey: true, code: 'KeyP', key: 'P' }), 'Ctrl+Shift+P');
  assert.equal(eventShortcut({ ctrlKey: true, code: 'Backquote', key: '`' }), 'Ctrl+`');
  assert.equal(eventShortcut({ altKey: true, code: 'BracketRight', key: ']' }), 'Alt+]');
  assert.equal(displayShortcut('Mod+S'), 'Ctrl+S');
});

/** A stand-in for a DOM element (the registry checks `instanceof Element`). */
function fakeElement(tagName, closest = () => null) {
  globalThis.Element ??= class {};
  return Object.assign(Object.create(globalThis.Element.prototype), { tagName, closest });
}

function keyEvent(props, target = fakeElement('DIV')) {
  let prevented = false;
  return {
    code: '', key: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target,
    preventDefault() { prevented = true; },
    stopPropagation() {},
    get prevented() { return prevented; },
    ...props,
  };
}

test('the command registry dispatches keys with its rules', async () => {
  const ran = [];
  const app = {};
  const commands = createCommands(app);
  commands.register({ id: 'save', title: 'Save', keys: 'Mod+S', run: () => ran.push('save') });
  commands.register({ id: 'undo', title: 'Undo', keys: 'Mod+Z', native: true, run: () => ran.push('undo') });
  commands.register({ id: 'term', title: 'Toggle', keys: 'Mod+`', terminal: true, run: () => ran.push('term') });
  commands.register({ id: 'off', title: 'Disabled', keys: 'F2', when: () => false, run: () => ran.push('off') });

  const save = keyEvent({ ctrlKey: true, code: 'KeyS' });
  assert.equal(commands.handleKey(save), true);
  assert.equal(save.prevented, true);
  // Editor-native shortcuts are left to the editor.
  assert.equal(commands.handleKey(keyEvent({ ctrlKey: true, code: 'KeyZ' })), false);
  // Disabled commands do not swallow the key.
  assert.equal(commands.handleKey(keyEvent({ code: 'F2' })), false);
  // Inside the terminal only `terminal: true` shortcuts apply.
  const inTerminal = fakeElement('TEXTAREA', (sel) => (sel === '.terminal-host' ? {} : null));
  assert.equal(commands.handleKey(keyEvent({ ctrlKey: true, code: 'KeyS', target: inTerminal })), false);
  assert.equal(commands.handleKey(keyEvent({ ctrlKey: true, code: 'Backquote', target: inTerminal })), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ran, ['save', 'term']);
  assert.equal(commands.shortcut('save'), 'Ctrl+S');
  assert.equal(commands.enabled('off'), false);
});

test('the bus isolates failing handlers', () => {
  const bus = createBus();
  const seen = [];
  const off = bus.on('x', (v) => seen.push(`a${v}`));
  bus.on('x', () => {
    throw new Error('boom');
  });
  bus.on('x', (v) => seen.push(`c${v}`));
  const originalError = console.error;
  console.error = () => {};
  bus.emit('x', 1);
  off();
  bus.emit('x', 2);
  console.error = originalError;
  assert.deepEqual(seen, ['a1', 'c1', 'c2']);
});

// Issue #1: CodeMirror draws the selection in a layer behind the lines, so an
// opaque active-line color hid any selection that stayed on one line (Dos and
// Eye Burned). Every theme's --editor-line must let the selection show through.
test('every theme keeps the active line translucent', () => {
  const css = readFileSync(new URL('../src/styles/themes.css', import.meta.url), 'utf8');
  const blocks = new Map();
  for (const [, id, body] of css.matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)) blocks.set(id, body);
  for (const { id } of THEMES) {
    assert.ok(blocks.has(id), `themes.css has no block for ${id}`);
    const value = /--editor-line:\s*(#[0-9a-fA-F]+)/.exec(blocks.get(id))?.[1];
    assert.ok(value, `${id} defines --editor-line`);
    assert.match(value, /^#[0-9a-fA-F]{8}$/, `${id}: --editor-line ${value} needs an alpha (#rrggbbaa)`);
    assert.ok(parseInt(value.slice(7), 16) < 0xff, `${id}: --editor-line ${value} is opaque`);
  }
});
