/**
 * Auto save (`editor.auto_save`): `delay` saves a document a moment after
 * the last change, `focus` saves when the editor or the window loses focus.
 * Documents in conflict with the disk are never auto-saved: the user decides.
 */
export function register(app) {
  const timers = new Map();
  const mode = () => app.settings.get('editor.auto_save', 'off');

  const saveIfNeeded = (doc) => {
    if (doc && doc.kind === 'text' && doc.dirty && !doc.conflict && !doc.readonly && app.documents.get(doc.path) === doc) {
      app.documents.save(doc);
    }
  };

  app.bus.on('doc:dirty', (doc) => {
    if (mode() !== 'delay' || !doc.dirty) return;
    clearTimeout(timers.get(doc.id));
    timers.set(doc.id, setTimeout(() => saveIfNeeded(doc), app.settings.get('editor.auto_save_delay_ms', 1000)));
  });
  app.bus.on('editor:cursor', () => {
    // Keep pushing the delay back while typing.
    const doc = app.tabs.activeDoc;
    if (mode() !== 'delay' || !doc?.dirty || !timers.has(doc.id)) return;
    clearTimeout(timers.get(doc.id));
    timers.set(doc.id, setTimeout(() => saveIfNeeded(doc), app.settings.get('editor.auto_save_delay_ms', 1000)));
  });
  app.bus.on('editor:blur', (doc) => {
    if (mode() === 'focus') saveIfNeeded(doc);
  });
  window.addEventListener('blur', () => {
    if (mode() === 'focus') for (const doc of app.documents.dirty()) saveIfNeeded(doc);
  });
}
