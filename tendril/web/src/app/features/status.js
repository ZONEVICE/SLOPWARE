/**
 * Status bar items: workspace, cursor position, indentation, encoding,
 * line endings, language, editor engine and the time left before the
 * server closes itself for inactivity (with a warning near the end).
 */
import { h } from '../core/dom.js';
import { duration } from '../core/format.js';
import { icon } from '../core/icons.js';
import { EDITORS } from '../workbench/editorhost.js';

const WARN_AT = 5 * 60;

export function register(app) {
  const sb = app.statusbar;
  const workspace = sb.add({ id: 'workspace', side: 'left', order: 1, tip: 'Open another folder', onClick: () => app.commands.run('workspace.open') });
  workspace.append(icon('folder'), h('span', { text: app.workspace.name }));
  const readonly = sb.add({ id: 'readonly', side: 'left', order: 5, className: 'status-warn' });
  const conflict = sb.add({ id: 'conflict', side: 'left', order: 6, className: 'status-warn', tip: 'The file changed on disk; saving will ask what to do', onClick: () => app.commands.run('file.save') });

  const cursor = sb.add({ id: 'cursor', order: 10, tip: 'Go to Line', onClick: () => app.commands.run('goto.line') });
  const indent = sb.add({ id: 'indent', order: 20, tip: 'Change Indentation', onClick: () => app.commands.run('editor.indentation') });
  const encoding = sb.add({ id: 'encoding', order: 30, tip: 'Toggle UTF-8 BOM', onClick: () => app.commands.run('editor.bom') });
  const eol = sb.add({ id: 'eol', order: 40, tip: 'Change Line Endings', onClick: () => app.commands.run('editor.eol') });
  const language = sb.add({ id: 'language', order: 50, tip: 'Change Language Mode', onClick: () => app.commands.run('editor.language') });
  const engine = sb.add({
    id: 'engine',
    order: 60,
    tip: 'Switch editor (CodeMirror / Monaco)',
    onClick: () => app.commands.run(app.editors.kind === 'monaco' ? 'editor.use.codemirror' : 'editor.use.monaco'),
  });
  const idle = sb.add({ id: 'idle', order: 90, tip: 'Time left before Tendril stops for inactivity' });

  const textItems = [cursor, indent, encoding, eol, language];

  function refreshDoc() {
    const doc = app.tabs.activeDoc;
    const isText = doc?.kind === 'text';
    for (const el of textItems) el.hidden = !isText;
    readonly.hidden = !doc?.readonly;
    readonly.textContent = 'Read-only';
    conflict.hidden = !doc?.conflict;
    conflict.textContent = 'Changed on disk';
    if (!isText) return;
    indent.textContent = doc.indent.tabs ? `Tab Size: ${doc.indent.size}` : `Spaces: ${doc.indent.size}`;
    encoding.textContent = doc.bom ? 'UTF-8 with BOM' : 'UTF-8';
    eol.textContent = doc.eol === 'crlf' ? 'CRLF' : 'LF';
    language.textContent = doc.language.name;
  }

  app.bus.on('editor:cursor', (info) => {
    cursor.textContent = `Ln ${info.line}, Col ${info.col}${info.selected ? ` (${info.selected} selected)` : ''}${info.cursors > 1 ? ` · ${info.cursors} cursors` : ''}`;
  });
  for (const event of ['tab:active', 'doc:language', 'doc:indent', 'doc:eol', 'doc:reloaded', 'doc:conflict', 'doc:dirty', 'doc:renamed']) app.bus.on(event, refreshDoc);
  app.bus.on('editor:switched', (kind) => {
    engine.textContent = EDITORS.find((e) => e.id === kind)?.name || kind;
  });
  engine.textContent = EDITORS.find((e) => e.id === app.settings.get('default_editor'))?.name || '';
  refreshDoc();

  // A new timeout set in Settings applies at once: fetch the new time left.
  app.bus.on('settings:changed', (_settings, patch) => {
    if (patch && 'idle_timeout_minutes' in patch) app.activity?.poll();
  });

  // Near the end the countdown shows seconds (it ticks every second).
  const clock = (seconds) => (seconds <= WARN_AT ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : duration(seconds));
  let warned = null;
  app.bus.on('idle:status', ({ remaining, timeout }) => {
    if (remaining === undefined) return;
    idle.replaceChildren(icon('hourglass'), h('span', { text: clock(remaining) }));
    if (timeout) idle.setAttribute('data-tip', `Tendril stops itself after ${duration(timeout)} without activity`);
    idle.classList.toggle('status-warn', remaining <= WARN_AT);
    if (remaining <= WARN_AT && !warned) {
      const dirty = app.documents.dirty().length;
      warned = app.ui.toast.warn(
        `Tendril will stop in ${duration(remaining)} because nobody is using it.${dirty ? ` ${dirty} file(s) are not saved!` : ''}`,
        { sticky: true, actions: [{ label: "I'm here", primary: true, run: () => app.activity.ping() }] },
      );
    } else if (remaining > WARN_AT && warned) {
      warned.close();
      warned = null;
    }
  });
}
