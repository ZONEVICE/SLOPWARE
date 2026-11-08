/**
 * The document model: what the workbench knows about each open file,
 * independent of which editor shows it. Switching between CodeMirror and
 * Monaco never loses unsaved changes because the editor adapters hand their
 * text back to this model (`doc.text`, `doc.dirty`) before being destroyed.
 *
 * A document is one of these kinds:
 *   text     editable in an editor
 *   image | video | audio | pdf   shown by a viewer
 *   binary   not UTF-8 text: download only
 *   large    above the editor size limit: download only
 *
 * Saving lives here too (`save`, `saveAs`), including the conflict dialog
 * when the file changed on disk, the on-save cleanups (trim whitespace, final
 * newline) and the BOM / line-ending bookkeeping.
 */
import { api } from '../core/api.js';
import { downloadUrl } from '../core/dom.js';
import { detectIndent } from '../core/indent.js';
import { languageFor, viewerFor } from '../core/languages.js';
import { basename } from '../core/paths.js';

let nextId = 1;

export class Doc {
  constructor(path, kind) {
    this.id = `d${nextId++}`;
    this.path = path;
    this.kind = kind;
    this.name = basename(path);
    this.text = '';
    this.dirty = false;
    this.eol = 'lf';
    this.bom = false;
    this.mtime = null;
    this.size = 0;
    this.readonly = false;
    this.language = languageFor(path);
    this.indent = { tabs: false, size: 4 };
    this.error = null; // message for binary/large documents
    this.conflict = false; // changed on disk while dirty
  }
}

export function createDocuments(app) {
  const docs = new Map(); // path -> Doc

  async function load(path) {
    const viewer = viewerFor(path);
    if (viewer) {
      const doc = new Doc(path, viewer);
      try {
        const stat = await api.get('/api/fs/stat', { query: { path } });
        doc.size = stat.size;
        doc.mtime = stat.mtime;
      } catch {
        /* the viewer will show the error */
      }
      return doc;
    }
    const doc = new Doc(path, 'text');
    try {
      const response = await api.raw('GET', '/api/fs/read', { query: { path } });
      doc.text = await response.text();
      doc.mtime = Number(response.headers.get('x-tendril-mtime'));
      doc.size = Number(response.headers.get('x-tendril-size'));
      doc.eol = response.headers.get('x-tendril-eol') || 'lf';
      doc.bom = response.headers.get('x-tendril-bom') === '1';
      doc.readonly = response.headers.get('x-tendril-readonly') === '1';
      applyIndentation(doc);
    } catch (err) {
      if (err.code === 'binary') {
        doc.kind = 'binary';
        doc.error = 'This file is binary or not UTF-8 text, so it cannot be edited here.';
      } else if (err.code === 'too_large') {
        doc.kind = 'large';
        doc.size = err.data.size;
        doc.error = `This file is larger than the ${Math.round(err.data.limit / 1048576)} MB editor limit.`;
      } else {
        throw err;
      }
    }
    return doc;
  }

  function applyIndentation(doc) {
    const editor = app.settings.all.editor || {};
    const fallback = { tabs: !editor.insert_spaces, size: editor.tab_size || 4 };
    doc.indent = editor.detect_indentation ? detectIndent(doc.text, fallback) : fallback;
  }

  /** Applies the on-save cleanups configured in settings to `text`. */
  function cleanup(text) {
    const editor = app.settings.all.editor || {};
    let out = text;
    if (editor.trim_trailing_whitespace) out = out.replace(/[ \t]+$/gm, '');
    if (editor.insert_final_newline && out.length && !out.endsWith('\n')) out += '\n';
    return out;
  }

  async function write(doc, text, { force = false } = {}) {
    const headers = { 'X-Tendril-Eol': doc.eol, 'X-Tendril-Bom': doc.bom ? '1' : '0' };
    if (!force && doc.mtime !== null) {
      headers['X-Tendril-Expect-Mtime'] = String(doc.mtime);
      headers['X-Tendril-Expect-Size'] = String(doc.size);
    }
    return api.put('/api/fs/write', text, { query: { path: doc.path }, headers });
  }

  const model = {
    /** The open document for `path`, if any. */
    get: (path) => docs.get(path),
    all: () => [...docs.values()],
    dirty: () => [...docs.values()].filter((d) => d.dirty),

    /**
     * The unsaved documents as files, with their own line endings and BOM,
     * copied now so they outlive the editor (see `downloadCopies`).
     */
    unsavedCopies: () =>
      model.dirty().map((doc) => {
        const text = app.editors.getText(doc) ?? '';
        const body = doc.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
        return { name: doc.name, blob: new Blob([doc.bom ? '\ufeff' : '', body], { type: 'text/plain' }) };
      }),

    /** Opens (or returns the already open) document for `path`. */
    async open(path) {
      if (docs.has(path)) return docs.get(path);
      const doc = await load(path);
      docs.set(path, doc);
      app.bus.emit('doc:opened', doc);
      return doc;
    },

    close(doc) {
      docs.delete(doc.path);
      app.bus.emit('doc:closed', doc);
    },

    /** Marks dirty/clean and tells everyone. */
    setDirty(doc, dirty) {
      if (doc.dirty === dirty) return;
      doc.dirty = dirty;
      if (!dirty) doc.conflict = false;
      app.bus.emit('doc:dirty', doc);
    },

    /** Saves a text document. Resolves true when saved. */
    async save(doc, { force = false } = {}) {
      if (doc.kind !== 'text') return false;
      if (doc.readonly) {
        app.ui.toast.warn(`${doc.name} is read-only.`);
        return false;
      }
      const original = app.editors.getText(doc);
      const text = cleanup(original);
      if (text !== original) app.editors.replaceText(doc, text, { keepDirty: true });
      try {
        const result = await write(doc, text, { force });
        doc.mtime = result.mtime;
        doc.size = result.size;
        doc.text = text;
        app.editors.markSaved(doc);
        model.setDirty(doc, false);
        app.bus.emit('doc:saved', doc);
        if (result.created) app.bus.emit('fs:changed', { paths: [doc.path] });
        return true;
      } catch (err) {
        if (err.code === 'conflict') return model.resolveConflict(doc, err.data);
        app.ui.toast.error(`Could not save ${doc.name}: ${err.message}`);
        return false;
      }
    },

    /** Asks what to do when the file changed on disk since it was opened. */
    async resolveConflict(doc, info) {
      const choice = await app.ui.dialog.choose({
        title: info.exists ? 'File changed on disk' : 'File deleted on disk',
        message: info.exists
          ? `${doc.path} was modified outside Tendril after you opened it. Overwrite it with your version, or discard your changes and reload it?`
          : `${doc.path} was deleted outside Tendril. Save your version again?`,
        choices: info.exists
          ? [
              { id: 'reload', label: 'Reload from disk', danger: true },
              { id: 'overwrite', label: 'Overwrite', primary: true },
            ]
          : [{ id: 'overwrite', label: 'Save again', primary: true }],
      });
      if (choice === 'overwrite') return model.save(doc, { force: true });
      if (choice === 'reload') await model.reload(doc);
      return false;
    },

    /** Re-reads a document from disk, discarding unsaved changes. */
    async reload(doc) {
      const fresh = await load(doc.path);
      Object.assign(doc, {
        kind: fresh.kind,
        text: fresh.text,
        mtime: fresh.mtime,
        size: fresh.size,
        eol: fresh.eol,
        bom: fresh.bom,
        readonly: fresh.readonly,
        error: fresh.error,
        conflict: false,
      });
      if (doc.kind === 'text') app.editors.replaceText(doc, fresh.text);
      model.setDirty(doc, false);
      app.bus.emit('doc:reloaded', doc);
    },

    /** Saves under a new workspace-relative path; the tab follows. */
    async saveAs(doc, path) {
      const text = cleanup(app.editors.getText(doc));
      try {
        await api.get('/api/fs/stat', { query: { path } });
        const overwrite = await app.ui.dialog.confirm({
          title: 'Replace file?',
          message: `${path} already exists. Replace it?`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!overwrite) return false;
      } catch (err) {
        if (err.code !== 'not_found') throw err;
      }
      const result = await api.put('/api/fs/write', text, {
        query: { path },
        headers: { 'X-Tendril-Eol': doc.eol, 'X-Tendril-Bom': doc.bom ? '1' : '0' },
      });
      model.rename(doc.path, path);
      doc.mtime = result.mtime;
      doc.size = result.size;
      doc.text = text;
      app.editors.markSaved(doc);
      model.setDirty(doc, false);
      app.bus.emit('fs:changed', { paths: [path] });
      app.bus.emit('doc:saved', doc);
      return true;
    },

    /** Follows a rename/move of `from` (file or folder) to `to`. */
    rename(from, to) {
      for (const doc of [...docs.values()]) {
        let next = null;
        if (doc.path === from) next = to;
        else if (doc.path.startsWith(`${from}/`)) next = to + doc.path.slice(from.length);
        if (!next) continue;
        docs.delete(doc.path);
        const previous = doc.path;
        doc.path = next;
        doc.name = basename(next);
        doc.language = languageFor(next);
        docs.set(next, doc);
        app.bus.emit('doc:renamed', doc, previous);
      }
    },

    /** Looks for external changes to open documents (quietly). */
    async checkDisk() {
      const open = [...docs.values()].filter((d) => d.kind === 'text' && d.mtime !== null);
      if (!open.length) return;
      let stats;
      try {
        stats = (await api.post('/api/fs/stats', { paths: open.map((d) => d.path) }, { quiet: true })).stats;
      } catch {
        return;
      }
      for (const doc of open) {
        const stat = stats[doc.path];
        if (!stat) continue;
        if (stat.mtime === doc.mtime && stat.size === doc.size) continue;
        if (doc.dirty) {
          if (!doc.conflict) {
            doc.conflict = true;
            app.bus.emit('doc:conflict', doc);
          }
        } else {
          await model.reload(doc);
        }
      }
    },

    applyIndentation,
  };
  return model;
}

/** Downloads files made by `documents.unsavedCopies()` through the browser. */
export function downloadCopies(copies) {
  for (const { name, blob } of copies) {
    const url = URL.createObjectURL(blob);
    downloadUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
