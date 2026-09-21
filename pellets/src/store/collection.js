/**
 * Generic in-memory collection with optional secondary indexes.
 *
 * EVERY store in Pellets is built on this. There is no database and no JSON on
 * disk: when the process exits, all chat state is gone, which is exactly the
 * behaviour the specification asks for. The only thing that outlives a restart
 * is the raw files under `uploads/`.
 *
 * Secondary indexes exist so a store can answer "which session has this
 * fingerprint?" without scanning every record.
 */
export class Collection {
  /**
   * @param {object} [options]
   * @param {string} [options.name] Label used in error messages.
   * @param {Record<string, (record:any)=>(string|null|undefined)>} [options.indexes]
   *   Map of index name -> key extractor. Returning null/undefined skips the
   *   record for that index.
   */
  constructor(options = {}) {
    this.name = options.name || 'collection';
    /** @type {Map<string, any>} */
    this.items = new Map();
    /** @type {Map<string, (record:any)=>(string|null|undefined)>} */
    this.indexDefinitions = new Map(Object.entries(options.indexes || {}));
    /** @type {Map<string, Map<string, string>>} index name -> (key -> id) */
    this.indexes = new Map();
    for (const indexName of this.indexDefinitions.keys()) {
      this.indexes.set(indexName, new Map());
    }
  }

  get size() {
    return this.items.size;
  }

  /** Insert or replace a record. The record must expose an `id`. */
  set(id, record) {
    if (!id) throw new TypeError(`${this.name}.set requires an id`);
    const previous = this.items.get(id);
    if (previous) this.#unindex(previous, id);
    this.items.set(id, record);
    this.#index(record, id);
    return record;
  }

  /** @returns {any|undefined} */
  get(id) {
    return this.items.get(id);
  }

  has(id) {
    return this.items.has(id);
  }

  /**
   * Shallow-merge a patch into an existing record and refresh its indexes.
   *
   * IMPORTANT: the record is mutated IN PLACE rather than replaced. Long-lived
   * holders of a record (an open WebSocket connection, a queued broadcast)
   * therefore never observe a stale copy. Treat records as living objects.
   *
   * @returns {any|null} The updated record, or null when the id is unknown.
   */
  update(id, patch) {
    const current = this.items.get(id);
    if (!current) return null;
    this.#unindex(current, id);
    Object.assign(current, patch);
    this.#index(current, id);
    return current;
  }

  /** @returns {boolean} true when something was removed. */
  delete(id) {
    const record = this.items.get(id);
    if (!record) return false;
    this.#unindex(record, id);
    this.items.delete(id);
    return true;
  }

  /** Look a record up through a secondary index. */
  findBy(indexName, key) {
    const index = this.indexes.get(indexName);
    if (!index || key === null || key === undefined) return undefined;
    const id = index.get(String(key));
    return id === undefined ? undefined : this.items.get(id);
  }

  /** @returns {any[]} Every record, in insertion order. */
  all() {
    return [...this.items.values()];
  }

  /** @returns {IterableIterator<any>} */
  values() {
    return this.items.values();
  }

  /** @returns {IterableIterator<string>} */
  keys() {
    return this.items.keys();
  }

  /** @returns {any[]} Records matching a predicate. */
  filter(predicate) {
    return this.all().filter(predicate);
  }

  clear() {
    this.items.clear();
    for (const index of this.indexes.values()) index.clear();
  }

  #index(record, id) {
    for (const [indexName, extract] of this.indexDefinitions) {
      const key = extract(record);
      if (key === null || key === undefined) continue;
      this.indexes.get(indexName).set(String(key), id);
    }
  }

  #unindex(record, id) {
    for (const [indexName, extract] of this.indexDefinitions) {
      const key = extract(record);
      if (key === null || key === undefined) continue;
      const index = this.indexes.get(indexName);
      // Only drop the entry when it still points at this record: another
      // record may legitimately have taken over the key.
      if (index.get(String(key)) === id) index.delete(String(key));
    }
  }
}

/**
 * Multi-valued map helper: key -> Set of values. Used by the presence store,
 * where one room holds many sessions and one session holds many connections.
 */
export class SetMap {
  constructor() {
    /** @type {Map<string, Set<string>>} */
    this.map = new Map();
  }

  add(key, value) {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(value);
    return set;
  }

  /** @returns {boolean} true when the key became empty and was dropped. */
  remove(key, value) {
    const set = this.map.get(key);
    if (!set) return false;
    set.delete(value);
    if (set.size === 0) {
      this.map.delete(key);
      return true;
    }
    return false;
  }

  /** @returns {Set<string>} Always a set, possibly empty. */
  get(key) {
    return this.map.get(key) || new Set();
  }

  has(key, value) {
    const set = this.map.get(key);
    return Boolean(set && set.has(value));
  }

  count(key) {
    const set = this.map.get(key);
    return set ? set.size : 0;
  }

  deleteKey(key) {
    return this.map.delete(key);
  }

  keys() {
    return [...this.map.keys()];
  }

  clear() {
    this.map.clear();
  }
}
