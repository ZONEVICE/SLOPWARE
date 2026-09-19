import { DEFAULT_CONFIG, configSnapshot } from './config.js';

export const STORAGE_KEYS = Object.freeze({
  config: 'guanaco.config.v1',
  workspace: 'guanaco.workspace.v1',
});

const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const PENDING = new Set(['queued', 'running']);

export function createId(prefix = 'item') {
  const unique = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${unique}`;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function restoreTurn(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.prompt !== 'string'
      || typeof raw.content !== 'string' || typeof raw.thinking !== 'string'
      || !STATUSES.has(raw.status) || !validDate(raw.createdAt)) {
    throw new Error('The saved workspace contains an invalid turn.');
  }
  const interrupted = PENDING.has(raw.status);
  return {
    id: raw.id,
    prompt: raw.prompt,
    content: raw.content,
    thinking: raw.thinking,
    status: interrupted ? 'interrupted' : raw.status,
    error: interrupted ? 'This request was interrupted when the page closed. Retry it to continue.' : String(raw.error || ''),
    createdAt: raw.createdAt,
    metrics: raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics) ? raw.metrics : null,
  };
}

function restoreWorkspace(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.chats) || !Array.isArray(raw.jobs)) {
    throw new Error('The saved workspace has an unsupported format.');
  }
  const seenIds = new Set();
  const claimId = id => {
    if (seenIds.has(id)) throw new Error('The saved workspace contains duplicate identifiers.');
    seenIds.add(id);
  };
  const chats = raw.chats.map(chat => {
    if (!chat || typeof chat.id !== 'string' || typeof chat.title !== 'string'
        || !validDate(chat.createdAt) || !Array.isArray(chat.turns)
        || !['global', 'custom'].includes(chat.configMode)) {
      throw new Error('The saved workspace contains an invalid chat.');
    }
    claimId(chat.id);
    const turns = chat.turns.map(restoreTurn);
    turns.forEach(turn => claimId(turn.id));
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      configMode: chat.configMode,
      config: configSnapshot(chat.config),
      turns,
    };
  });
  const jobs = raw.jobs.map(job => {
    const chat = chats.find(item => item.id === job?.chatId);
    if (!job || typeof job.id !== 'string' || !STATUSES.has(job.status)
        || !validDate(job.createdAt) || !chat?.turns.some(turn => turn.id === job.turnId)) {
      throw new Error('The saved workspace contains an invalid queue entry.');
    }
    claimId(job.id);
    return {
      id: job.id,
      chatId: job.chatId,
      turnId: job.turnId,
      config: configSnapshot(job.config),
      status: PENDING.has(job.status) ? 'interrupted' : job.status,
      createdAt: job.createdAt,
    };
  });
  return { chats, jobs, paused: raw.paused === true };
}

/**
 * Small observable store; features mutate through methods or update a turn and
 * call notify(). Stream updates persist at most every 250ms, while terminal
 * transitions call save() immediately. Never replay saved work on page load.
 */
class Store {
  constructor(options = {}) {
    this.storageError = '';
    this.state = { config: configSnapshot(DEFAULT_CONFIG), chats: [], jobs: [], paused: false };
    this.listeners = new Set();
    this.saveTimer = null;
    this.storage = null;
    try {
      // Storage injection keeps browser tests away from the user's workspace
      // and permits future storage adapters without coupling features to it.
      this.storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
      const rawConfig = this.storage?.getItem(STORAGE_KEYS.config);
      if (rawConfig) this.state.config = configSnapshot(JSON.parse(rawConfig));
    } catch (error) {
      this.storageError = `Saved defaults could not be loaded: ${error.message}`;
    }
    try {
      const rawWorkspace = this.storage?.getItem(STORAGE_KEYS.workspace);
      if (rawWorkspace) Object.assign(this.state, restoreWorkspace(JSON.parse(rawWorkspace)));
    } catch (error) {
      this.storageError = `Saved chats could not be loaded: ${error.message}`;
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, 250);
    }
    for (const listener of this.listeners) {
      try { listener(this.state); }
      catch (error) { console.error('A Guanaco store subscriber failed.', error); }
    }
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    let errorMessage = '';
    // Save defaults first, independently of the potentially large transcript.
    // A quota failure leaves the in-memory app usable and the prior save intact.
    try {
      if (!this.storage) throw new Error('Browser storage is unavailable.');
      this.storage.setItem(STORAGE_KEYS.config, JSON.stringify(this.state.config));
    } catch (error) { errorMessage = `Settings could not be saved: ${error.message}`; }
    try {
      if (!this.storage) throw new Error('Browser storage is unavailable.');
      this.storage.setItem(STORAGE_KEYS.workspace, JSON.stringify({
        version: 1,
        chats: this.state.chats,
        jobs: this.state.jobs,
        paused: this.state.paused,
      }));
    } catch (error) { errorMessage = `Chats could not be saved. Browser storage may be full or disabled: ${error.message}`; }
    const changed = this.storageError !== errorMessage;
    this.storageError = errorMessage;
    if (changed) {
      for (const listener of this.listeners) {
        try { listener(this.state); }
        catch (error) { console.error('A Guanaco store subscriber failed.', error); }
      }
    }
    return !errorMessage;
  }

  setConfig(config) {
    this.state.config = configSnapshot(config);
    this.save();
    this.notify();
  }

  createChat() {
    const chat = {
      id: createId('chat'),
      title: 'Untitled chat',
      createdAt: new Date().toISOString(),
      configMode: 'global',
      config: configSnapshot(this.state.config),
      turns: [],
    };
    this.state.chats.push(chat);
    this.save();
    this.notify();
    return chat;
  }

  updateChatConfig(id, configOrNull) {
    const chat = this.state.chats.find(item => item.id === id);
    if (!chat) throw new Error('Chat was not found.');
    chat.config = configSnapshot(configOrNull === null ? this.state.config : configOrNull);
    chat.configMode = configOrNull === null ? 'global' : 'custom';
    this.save();
    this.notify();
    return chat;
  }

  deleteChat(id) {
    if (this.state.jobs.some(job => job.chatId === id && PENDING.has(job.status))) {
      throw new Error('Cancel this chat’s pending requests before deleting it.');
    }
    this.state.chats = this.state.chats.filter(chat => chat.id !== id);
    this.state.jobs = this.state.jobs.filter(job => job.chatId !== id);
    this.save();
    this.notify();
  }
}

export function createStore(options) { return new Store(options); }
