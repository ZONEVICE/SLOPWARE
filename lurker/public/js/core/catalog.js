/**
 * The browser's copy of the album catalog, kept in step with the server by
 * revision deltas: when the album status announces a newer revision, sync()
 * asks for what changed since the one it has. Derived data (the flat list,
 * per-folder lists, recursive counts) is rebuilt lazily once per change.
 */
import { api } from './api.js';

export class Catalog extends EventTarget {
  constructor() {
    super();
    this.albumId = null;
    this.rev = 0;
    this.items = new Map();
    this.folders = new Map();
    this.formats = new Map();
    this.version = 0;
    this.loaded = false;
    this._derived = null;
    this._syncing = false;
    this._wanted = null;
  }

  setFormats(list) {
    this.formats = new Map(list.map((format) => [format.key, format]));
  }

  reset(albumId = null) {
    this.albumId = albumId;
    this.rev = 0;
    this.items.clear();
    this.folders.clear();
    this.loaded = false;
    this._changed();
  }

  /** Follow an album status: reset on a new album, fetch deltas on a new revision. */
  sync(status) {
    if (!status || status.status === 'empty') {
      if (this.albumId !== null) this.reset(null);
      return;
    }
    if (status.id !== this.albumId) this.reset(status.id);
    if (status.rev > this.rev || !this.loaded) {
      this._wanted = status;
      this._pump();
    }
  }

  async _pump() {
    if (this._syncing) return;
    this._syncing = true;
    try {
      while (this._wanted) {
        const status = this._wanted;
        this._wanted = null;
        if (status.id !== this.albumId) continue;
        if (this.loaded && status.rev <= this.rev) continue;
        let delta;
        try {
          delta = await api.delta(status.id, this.loaded ? this.rev : 0);
        } catch (error) {
          if (error.code === 'album_changed' || error.code === 'no_album') break; // the next status will say what happened
          await new Promise((resolve) => setTimeout(resolve, 1500));
          this._wanted = this._wanted || status;
          continue;
        }
        if (delta.album !== this.albumId) continue;
        this.apply(delta);
      }
    } finally {
      this._syncing = false;
    }
  }

  apply(delta) {
    if (delta.full) {
      this.items.clear();
      this.folders.clear();
    }
    for (const wire of delta.folders) {
      this.folders.set(wire.i, { id: wire.i, parentId: wire.p, name: wire.n, hidden: Boolean(wire.x) });
    }
    for (const id of delta.removedFolders || []) this.folders.delete(id);
    for (const wire of delta.items) this.items.set(wire.i, this._item(wire));
    for (const id of delta.removedItems || []) this.items.delete(id);
    this.rev = delta.rev;
    this.loaded = true;
    this._changed();
  }

  _item(wire) {
    const format = this.formats.get(wire.f) || { key: wire.f, label: wire.f.toUpperCase(), kind: 'image', browser: 'maybe', mime: '' };
    const dot = wire.n.lastIndexOf('.');
    return {
      id: wire.i,
      folderId: wire.d,
      name: wire.n,
      ext: dot >= 0 ? wire.n.slice(dot + 1).toLowerCase() : '',
      format,
      kind: format.kind,
      size: wire.s,
      mtime: wire.m,
      version: wire.v,
      hidden: Boolean(wire.x),
      probed: Boolean(wire.p),
      width: wire.w ?? null,
      height: wire.h ?? null,
      duration: wire.u ?? null,
      taken: wire.t ?? null,
      takenUtc: Boolean(wire.z),
      birth: wire.b ?? null,
      orientation: wire.o ?? null,
      camera: wire.c ?? null,
      codec: wire.k ?? null,
      animated: Boolean(wire.a),
      preview: wire.r || 0,
    };
  }

  _changed() {
    this.version += 1;
    this._derived = null;
    this.dispatchEvent(new Event('change'));
  }

  get list() {
    return this.derived().list;
  }

  /** Lazily built indexes, valid until the next change. */
  derived() {
    if (this._derived) return this._derived;
    const list = [...this.items.values()];
    const byFolder = new Map();
    const children = new Map();
    const stats = new Map();
    const formatCounts = new Map();
    const cameras = new Map();
    for (const folder of this.folders.values()) {
      stats.set(folder.id, { images: 0, videos: 0, bytes: 0, count: 0 });
      if (folder.parentId !== null && folder.parentId !== undefined) {
        if (!children.has(folder.parentId)) children.set(folder.parentId, []);
        children.get(folder.parentId).push(folder);
      }
    }
    for (const item of list) {
      if (!byFolder.has(item.folderId)) byFolder.set(item.folderId, []);
      byFolder.get(item.folderId).push(item);
      formatCounts.set(item.format.key, (formatCounts.get(item.format.key) || 0) + 1);
      if (item.camera) cameras.set(item.camera, (cameras.get(item.camera) || 0) + 1);
      // Recursive totals: add the item to its folder and every ancestor.
      let folder = this.folders.get(item.folderId);
      let guard = 0;
      while (folder && guard < 512) {
        const total = stats.get(folder.id);
        total.count += 1;
        total.bytes += item.size;
        if (item.kind === 'video') total.videos += 1;
        else total.images += 1;
        folder = folder.parentId === null ? null : this.folders.get(folder.parentId);
        guard += 1;
      }
    }
    for (const list_ of children.values()) list_.sort((a, b) => compareNames(a.name, b.name));
    const root = [...this.folders.values()].find((folder) => folder.parentId === null) || null;
    this._derived = { list, byFolder, children, stats, formatCounts, cameras, root };
    return this._derived;
  }

  folderPath(folderId) {
    const parts = [];
    let folder = this.folders.get(folderId);
    let guard = 0;
    while (folder && folder.parentId !== null && guard < 512) {
      parts.unshift(folder.name);
      folder = this.folders.get(folder.parentId);
      guard += 1;
    }
    return parts.join('/');
  }

  /** The folder chain from the root down to `folderId`. */
  ancestry(folderId) {
    const chain = [];
    let folder = this.folders.get(folderId);
    let guard = 0;
    while (folder && guard < 512) {
      chain.unshift(folder);
      folder = folder.parentId === null ? null : this.folders.get(folder.parentId);
      guard += 1;
    }
    return chain;
  }

  /** Items of a folder, optionally with everything below it. */
  itemsIn(folderId, recursive) {
    const { byFolder, children } = this.derived();
    if (!recursive) return byFolder.get(folderId) || [];
    const result = [];
    const stack = [folderId];
    while (stack.length) {
      const id = stack.pop();
      const own = byFolder.get(id);
      if (own) result.push(...own);
      for (const child of children.get(id) || []) stack.push(child.id);
    }
    return result;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a, b) {
  return collator.compare(a, b);
}
