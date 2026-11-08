/**
 * The extra-keys bar for touch screens: phone keyboards lack Tab, arrows and
 * most brackets, so while an editor has focus a row of keys sits above the
 * on-screen keyboard. Buttons never take the focus away from the editor.
 */
import { h, isTouch } from '../core/dom.js';
import { icon } from '../core/icons.js';

export function register(app) {
  if (!isTouch()) return;
  const indentText = () => {
    const doc = app.tabs.activeDoc;
    return doc?.indent?.tabs ? '\t' : ' '.repeat(doc?.indent?.size || 4);
  };
  const keys = [
    { label: 'Tab', run: () => app.editors.exec('insertText', indentText()) },
    { icon: 'arrow-left', label: 'Left', run: () => app.editors.exec('cursorLeft') },
    { label: '↑', run: () => app.editors.exec('cursorUp') },
    { label: '↓', run: () => app.editors.exec('cursorDown') },
    { label: '→', run: () => app.editors.exec('cursorRight') },
    ...['{', '}', '(', ')', '[', ']', ';', '=', '"', "'", '<', '>', '/'].map((ch) => ({ label: ch, run: () => app.editors.exec('insertText', ch) })),
    { icon: 'undo', label: 'Undo', run: () => app.editors.exec('undo') },
    { icon: 'redo', label: 'Redo', run: () => app.editors.exec('redo') },
    { icon: 'save', label: 'Save', run: () => app.commands.run('file.save') },
  ];
  const bar = h('div.keybar.editor-keybar', { role: 'toolbar', 'aria-label': 'Extra keys', hidden: true },
    keys.map((key) => {
      const btn = h('button.keybar-key', { type: 'button', 'aria-label': key.label }, key.icon ? icon(key.icon) : key.label);
      btn.addEventListener('pointerdown', (event) => event.preventDefault());
      btn.addEventListener('click', () => key.run());
      return btn;
    }));
  document.body.append(bar);

  const place = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const bottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    bar.style.bottom = `${bottom}px`;
  };
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);

  let hideTimer = null;
  app.bus.on('editor:focus', () => {
    clearTimeout(hideTimer);
    bar.hidden = false;
    place();
  });
  app.bus.on('editor:blur', () => {
    hideTimer = setTimeout(() => {
      bar.hidden = true;
    }, 200);
  });
}
