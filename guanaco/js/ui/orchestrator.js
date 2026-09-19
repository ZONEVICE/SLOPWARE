import { el, button, badge, configurationBadge, shortModel, chatStatus, statusLabel, submitShortcut, jobForTurn } from './dom.js';

/** The board is a keyed collection: streaming never replaces an in-progress prompt. */
export function createOrchestrator(context) {
  const { store, queue, openChat, editChatConfig, removeChat, newChat, toast } = context;
  const root = el('div');
  const count = el('span', { class: 'muted' });
  const stats = [
    ['Active generation', 'One request at a time'], ['Waiting in queue', 'Ordered by submission'], ['Completed requests', 'Ready to continue'], ['Conversations', 'Your prompt workspace']
  ].map(([label, detail], index) => {
    const value = el('strong', { class: 'stat-value', text: '0' });
    return { value, element: el('div', { class: `stat-card stat-${index}` }, el('span', { class: 'stat-label', text: label }), value, el('span', { class: 'stat-detail', text: detail })) };
  });
  const pause = button('Pause queue', () => queue.setPaused(!store.state.paused), 'button secondary small');
  const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Search conversations…', 'aria-label': 'Search conversations' });
  const filter = el('select', { 'aria-label': 'Filter conversations' }, ...[['all','All conversations'],['running','Generating'],['queued','Queued'],['completed','Completed'],['draft','Drafts'],['failed','Needs attention']].map(([value,text]) => el('option', { value,text })));
  const grid = el('div', { class: 'cards-grid' });
  const cards = new Map();
  const empty = el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', text: '↗' }), el('h2', { text: 'A space for your next idea' }), el('p', { text: 'Create a request window, write a prompt, and let the queue take care of the rest.' }), button('+ New request', newChat, 'button primary'));
  const noMatches = el('div', { class: 'empty-state', hidden: true }, el('h3', { text: 'No matching conversations' }), el('p', { text: 'Try a different search or filter.' }));
  const queueList = el('div', { class: 'queue-list' });
  let previousQueueSignature = '';
  const queueStatus = el('span', { class: 'queue-state' });
  const queuePanel = el('aside', { class: 'queue-panel', 'aria-label': 'Request queue' }, el('div', { class: 'section-heading' }, el('h2', { text: 'Live queue' }), queueStatus), el('p', { class: 'muted', text: 'Each request gets its own turn.' }), queueList, el('div', { class: 'queue-note', text: 'Managed here in Guanaco. Switch views freely while your requests run.' }));
  root.append(
    el('header', { class: 'view-header' }, el('div', {}, el('p', { class: 'eyebrow', text: 'YOUR LOCAL AI WORKSPACE' }), el('h1', { text: 'Request orchestrator' }), el('p', { class: 'subtitle', text: 'Many ideas. One orderly queue.' })), el('div', { class: 'actions' }, pause, button('+ New request', newChat, 'button primary', { id: 'new-request' }))),
    el('div', { class: 'stats-grid' }, stats.map(stat => stat.element)),
    el('div', { class: 'toolbar' }, el('div', { class: 'section-heading' }, el('h2', { text: 'Your conversations' }), count), el('div', { class: 'actions' }, search, filter)),
    el('div', { class: 'board-layout' }, el('div', {}, grid, empty, noMatches), queuePanel)
  );
  search.addEventListener('input', update); filter.addEventListener('change', update);

  function createCard(chat) {
    const title = button(chat.title, () => openChat(chat.id), 'card-title', { title: 'Open full conversation' });
    const status = badge('', 'draft');
    const configBadge = el('span');
    const model = el('span', { class: 'model-name' });
    const preview = el('p', { class: 'card-preview' });
    const promptPreview = el('p', { class: 'card-prompt' });
    const input = el('textarea', { rows: 3, placeholder: 'What would you like to explore?', 'aria-label': 'Prompt for this request', maxLength: 1000000 });
    const send = el('button', { type: 'submit', class: 'button primary small', text: 'Send request ↗' });
    const form = el('form', { class: 'card-compose' }, input, el('div', { class: 'composer-footer' }, el('span', { class: 'field-help', text: 'Ctrl / ⌘ + Enter' }), send));
    form.addEventListener('submit', event => {
      event.preventDefault();
      try { queue.enqueue(chat.id, input.value); input.value = ''; toast('Request added to the queue.'); } catch (error) { toast(error.message, true); }
    });
    submitShortcut(input, form);
    const footerInfo = el('span', { class: 'card-meta' });
    const cancel = button('Cancel', () => {
      const pending = store.state.jobs.find(job => job.chatId === chat.id && ['running','queued'].includes(job.status));
      if (pending) queue.cancel(pending.id);
    }, 'button ghost small');
    const article = el('article', { class: 'request-card', tabindex: 0, 'aria-label': 'Conversation window', dataset: { chatId: chat.id } },
      el('div', { class: 'card-header' }, status, el('div', { class: 'actions' }, button('⚙', () => editChatConfig(chat.id), 'icon-button', { title: 'Customize this conversation', 'aria-label': 'Customize this conversation' }), button('×', () => removeChat(chat.id), 'icon-button', { title: 'Delete conversation', 'aria-label': 'Delete conversation' }))),
      title, el('div', { class: 'card-tags' }, configBadge, model), promptPreview, preview, form,
      el('div', { class: 'card-footer' }, footerInfo, el('div', { class: 'actions' }, cancel, button('Open chat ↗', () => openChat(chat.id), 'button ghost small')))
    );
    article.addEventListener('click', event => { if (!event.target.closest('button,input,textarea,select,a,form')) openChat(chat.id); });
    article.addEventListener('keydown', event => { if (event.target === article && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openChat(chat.id); } });
    return { article, title, status, configBadge, model, preview, promptPreview, form, footerInfo, cancel, input };
  }

  function update() {
    const { chats, jobs, paused } = store.state;
    stats[0].value.textContent = jobs.filter(job => job.status === 'running').length;
    stats[1].value.textContent = jobs.filter(job => job.status === 'queued').length;
    stats[2].value.textContent = jobs.filter(job => job.status === 'completed').length;
    stats[3].value.textContent = chats.length;
    pause.textContent = paused ? '▶ Resume queue' : 'Ⅱ Pause queue';
    pause.classList.toggle('is-paused', paused);
    count.textContent = `${chats.length} total`;
    queueStatus.textContent = paused ? 'Paused' : 'FIFO';
    for (const [id, card] of cards) if (!chats.some(chat => chat.id === id)) { card.article.remove(); cards.delete(id); }
    let visible = 0;
    for (const chat of chats) {
      if (!cards.has(chat.id)) { const card = createCard(chat); cards.set(chat.id, card); grid.append(card.article); }
      const card = cards.get(chat.id), status = chatStatus(chat), last = chat.turns.at(-1);
      const matchesText = `${chat.title} ${chat.turns.map(turn => turn.prompt).join(' ')}`.toLowerCase().includes(search.value.toLowerCase());
      const matchesFilter = filter.value === 'all' || filter.value === status || (filter.value === 'failed' && ['failed','interrupted','cancelled'].includes(status));
      card.article.hidden = !(matchesText && matchesFilter); if (!card.article.hidden) visible++;
      card.article.classList.toggle('is-custom', chat.configMode === 'custom');
      card.article.classList.toggle('is-active', status === 'running');
      card.title.textContent = chat.title;
      card.status.className = `badge ${status}`;
      const queued = chat.turns.find(turn => turn.status === 'queued');
      const queuedJob = queued && jobForTurn(store.state, queued.id);
      card.status.textContent = status === 'queued' && queuedJob ? `Queued · #${queue.position(queuedJob.id)}` : statusLabel(status);
      card.configBadge.replaceChildren(configurationBadge(chat));
      card.model.textContent = shortModel(chat.config.model); card.model.title = chat.config.model;
      card.form.hidden = Boolean(chat.turns.length);
      card.promptPreview.hidden = !last; card.promptPreview.textContent = last?.prompt || '';
      card.preview.hidden = !last;
      card.preview.textContent = last ? (last.content || (last.thinking ? 'Thinking…' : last.error || (last.status === 'queued' ? 'Waiting for its turn in the queue.' : last.status === 'running' ? 'Waiting for the model…' : 'No response yet.'))) : '';
      card.footerInfo.textContent = chat.turns.length ? `${chat.turns.length} request${chat.turns.length === 1 ? '' : 's'}` : 'New conversation';
      card.cancel.hidden = !chat.turns.some(turn => ['queued','running'].includes(turn.status));
    }
    empty.hidden = chats.length > 0; grid.hidden = chats.length === 0; noMatches.hidden = chats.length === 0 || visible > 0;
    const pending = jobs.filter(job => ['running','queued'].includes(job.status));
    const queueSignature = JSON.stringify(pending.map(job => [job.id, job.status, job.waitingForLock, job.cancelling, queue.position(job.id), chats.find(chat => chat.id === job.chatId)?.title]));
    if (previousQueueSignature === queueSignature) return;
    previousQueueSignature = queueSignature;
    queueList.replaceChildren();
    if (!pending.length) queueList.append(el('div', { class: 'queue-empty' }, el('span', { class: 'queue-empty-mark', text: '✓' }), el('strong', { text: 'All clear' }), el('p', { text: 'Your next request can start right away.' })));
    pending.forEach(job => {
      const chat = chats.find(item => item.id === job.chatId), turn = chat?.turns.find(item => item.id === job.turnId);
      queueList.append(el('div', { class: `queue-item ${job.status}` }, el('span', { class: 'queue-position', text: job.status === 'running' ? '↻' : queue.position(job.id) }), el('div', { class: 'queue-item-content' }, button(chat?.title || 'Conversation', () => openChat(job.chatId), 'queue-title'), el('p', { text: job.cancelling ? 'Stopping…' : job.waitingForLock ? 'Waiting for another tab…' : job.status === 'running' ? 'Generating response…' : turn?.prompt || 'Waiting' })), button('×', () => queue.cancel(job.id), 'icon-button', { 'aria-label': 'Cancel queued request', title: 'Cancel request' })));
    });
  }
  update();
  return {
    element: root, update,
    focusChat(id) {
      // Creation reveals the new draft even if the previous filter excludes it.
      search.value = ''; filter.value = 'all'; update();
      const card = cards.get(id);
      if (card) { card.article.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card.input.focus(); }
    },
    destroy() {}
  };
}
