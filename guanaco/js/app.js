import { createStore } from './core/store.js';
import { RequestQueue } from './core/queue.js';
import { listModels, serverVersion } from './core/api.js';
import { createOrchestrator } from './ui/orchestrator.js';
import { createChatView } from './ui/chat.js';
import { createSettingsView } from './ui/settings.js';
import { createConfigForm } from './ui/config-form.js';
import { el, button } from './ui/dom.js';

/**
 * Composition root. Features receive an explicit context instead of globals.
 * The queue lives for the whole page lifetime, independently of active views.
 * To add a view, create its factory, register it here, and add a shell nav link.
 */
const store = createStore();
const queue = new RequestQueue(store);
const factories = { orchestrator: createOrchestrator, chat: createChatView, settings: createSettingsView };
const views = new Map(), modelCache = new Map();
let activeView = '', framePending = false, connectionSequence = 0, seenStorageError = '';

function toast(message, error = false) {
  const region = document.querySelector('#toast-region');
  const item = el('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, el('span', { text: message }), button('×', () => item.remove(), 'icon-button', { 'aria-label': 'Dismiss notification' }));
  region.append(item);
  while (region.children.length > 4) region.firstElementChild.remove();
  setTimeout(() => item.remove(), error ? 12000 : 5000);
}

/** Confirm destructive changes through a keyboard-accessible native dialog. */
function confirm(title, message, action = 'Confirm') {
  const dialog = document.querySelector('#confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  return new Promise(resolve => {
    let accepted = false;
    const finish = () => { dialog.replaceChildren(); resolve(accepted); };
    dialog.addEventListener('close', finish, { once: true });
    dialog.replaceChildren(el('div', { class: 'dialog-header' }, el('h2', { id: 'confirm-title', text: title })), el('div', { class: 'dialog-body' }, el('p', { text: message })), el('div', { class: 'dialog-footer' }, button('Cancel', () => dialog.close(), 'button secondary', { autofocus: true }), button(action, () => { accepted = true; dialog.close(); }, 'button primary')));
    dialog.setAttribute('aria-labelledby', 'confirm-title'); dialog.showModal();
  });
}

async function getModels(config, force = false) {
  const cached = modelCache.get(config.serverUrl);
  if (!force && cached && Date.now() - cached.createdAt < 30000) return cached.models;
  const models = await listModels(config);
  modelCache.set(config.serverUrl, { models, createdAt: Date.now() });
  return models;
}

async function checkConnection(config = store.state.config) {
  const sequence = ++connectionSequence;
  const label = document.querySelector('#connection-label');
  const indicator = document.querySelector('#connection-indicator');
  label.textContent = 'Connecting…'; indicator.dataset.status = 'connecting';
  document.querySelector('#server-label').textContent = config.serverUrl;
  try {
    const [models, version] = await Promise.all([getModels(config, true), serverVersion(config).catch(() => '')]);
    if (sequence === connectionSequence) { label.textContent = 'Ollama connected'; indicator.dataset.status = 'connected'; label.title = `${models.length} models available${version ? ` · v${version}` : ''}`; }
    return { ok: true, models, version };
  } catch (error) {
    if (sequence === connectionSequence) { label.textContent = 'Connection unavailable'; indicator.dataset.status = 'error'; label.title = error.message; }
    return { ok: false, error: error.message };
  }
}

function navigate(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else renderRoute();
}
function openChat(id) { context.selectedChatId = id; navigate('chat'); views.get('chat')?.update(); }
function newChat() {
  const chat = store.createChat(); context.selectedChatId = chat.id;
  navigate('orchestrator');
  // Render immediately because hashchange is asynchronous and focus needs DOM.
  renderRoute(); views.get('orchestrator')?.update(); views.get('orchestrator')?.focusChat(chat.id);
}
async function removeChat(id) {
  const chat = store.state.chats.find(item => item.id === id);
  if (!chat) return;
  if (store.state.jobs.some(job => job.chatId === id && ['queued','running'].includes(job.status))) { toast('Cancel this conversation’s pending requests before deleting it.', true); return; }
  if (chat.turns.length && !await confirm('Delete this conversation?', 'This removes its messages and request history from this browser.', 'Delete conversation')) return;
  try { store.deleteChat(id); if (context.selectedChatId === id) context.selectedChatId = store.state.chats[0]?.id || null; } catch (error) { toast(error.message, true); }
}

function editChatConfig(id) {
  const chat = store.state.chats.find(item => item.id === id);
  if (!chat) return;
  const dialog = document.querySelector('#config-dialog');
  if (dialog.open) return;
  const editor = createConfigForm(chat.config, { getModels, submitLabel: 'Apply to this conversation', onSubmit: config => { store.updateChatConfig(id, config); dialog.close(); toast('Custom configuration applied to future messages in this conversation.'); } });
  dialog.replaceChildren(
    el('div', { class: 'dialog-header' }, el('div', {}, el('p', { class: 'eyebrow', text: 'PER-CONVERSATION SETTINGS' }), el('h2', { id: 'chat-config-title', text: 'Make this chat your own' })), button('×', () => dialog.close(), 'icon-button', { 'aria-label': 'Close chat configuration' })),
    el('div', { class: 'dialog-body' }, el('p', { class: 'muted', text: 'These settings apply only to future messages in this conversation. Requests already in the queue keep their submitted settings.' }), button('Use current global defaults', () => { store.updateChatConfig(id, null); dialog.close(); toast('This conversation now uses a fresh snapshot of global defaults.'); }, 'button secondary small'), editor.element)
  );
  dialog.classList.add('dialog-wide'); dialog.setAttribute('aria-labelledby', 'chat-config-title');
  dialog.addEventListener('close', () => { editor.destroy(); dialog.replaceChildren(); }, { once: true });
  dialog.showModal();
}

const context = { store, queue, toast, confirm, getModels, checkConnection, navigate, openChat, newChat, removeChat, editChatConfig, selectedChatId: store.state.chats[0]?.id || null };

function renderRoute() {
  const requested = location.hash.slice(1);
  const view = Object.hasOwn(factories, requested) ? requested : 'orchestrator';
  if (!views.has(view)) {
    const instance = factories[view](context);
    views.set(view, instance); document.querySelector(`#${view}-view`).replaceChildren(instance.element);
  }
  for (const key of Object.keys(factories)) document.querySelector(`#${key}-view`).hidden = key !== view;
  for (const item of document.querySelectorAll('[data-nav]')) {
    const isActive = item.dataset.nav === view;
    item.classList.toggle('active', isActive); if (isActive) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  views.get(view).update();
  if (activeView !== view) { activeView = view; document.title = `${({ orchestrator: 'Orchestrator', chat: 'Chat', settings: 'Configuration' })[view]} · Guanaco`; }
}

store.subscribe(() => {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false; views.get(activeView)?.update();
    if (store.storageError && store.storageError !== seenStorageError) { seenStorageError = store.storageError; toast(store.storageError, true); }
  });
});
window.addEventListener('hashchange', renderRoute);
window.addEventListener('pagehide', () => store.save());
window.addEventListener('beforeunload', event => {
  if (store.state.jobs.some(job => ['running','queued'].includes(job.status))) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('storage', event => {
  if (event.key?.startsWith('guanaco.')) toast('Another tab changed this workspace. Keep one editing tab open to avoid competing saves.', true);
});
renderRoute();
if (store.storageError) { seenStorageError = store.storageError; toast(store.storageError, true); }
checkConnection();
