import { el, button, badge, configurationBadge, shortModel, chatStatus, statusLabel, jobForTurn, submitShortcut, renderMarkdown, formatDate } from './dom.js';

/** A chat is a projection of queue turns; navigating never owns or cancels work. */
export function createChatView(context) {
  const { store, queue, toast, openChat, editChatConfig, newChat } = context;
  const root = el('div');
  const list = el('div', { class: 'chat-list' });
  const sidebar = el('aside', { class: 'chat-sidebar' }, el('div', { class: 'section-heading' }, el('h2', { text: 'Conversations' }), button('+', newChat, 'icon-button', { 'aria-label': 'New conversation' })), list);
  const title = el('h2'), configBadge = el('span'), model = el('span', { class: 'model-name' });
  const messages = el('div', { class: 'chat-messages', 'aria-label': 'Conversation messages', tabindex: 0 });
  const banner = el('div', { class: 'status-banner', role: 'status' });
  const input = el('textarea', { rows: 3, placeholder: 'Continue the conversation…', 'aria-label': 'Message', maxLength: 1000000 });
  const send = el('button', { class: 'button primary', type: 'submit', text: 'Send message ↗' });
  const composer = el('form', { class: 'composer' }, input, el('div', { class: 'composer-footer' }, el('span', { class: 'field-help', text: 'Ctrl / ⌘ + Enter to send · Each message joins the shared queue' }), send));
  const chatMain = el('section', { class: 'chat-main' }, el('header', { class: 'chat-header' }, el('div', {}, title, el('div', { class: 'card-tags' }, configBadge, model)), button('⚙ Chat configuration', () => context.selectedChatId && editChatConfig(context.selectedChatId), 'button secondary small')), banner, messages, composer);
  const empty = el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', text: '☷' }), el('h2', { text: 'Keep the conversation going' }), el('p', { text: 'Select a conversation or create your first request.' }), button('+ New request', newChat, 'button primary'));
  root.append(el('header', { class: 'view-header' }, el('div', {}, el('p', { class: 'eyebrow', text: 'A LITTLE MORE ROOM TO THINK' }), el('h1', { text: 'Chat workspace' }), el('p', { class: 'subtitle', text: 'Every conversation, connected to the same queue.' })), button('← Orchestrator', () => context.navigate('orchestrator'), 'button secondary')), el('div', { class: 'chat-layout' }, sidebar, chatMain, empty));
  const rendered = new Map(), drafts = new Map();
  let currentId = null, previousSidebar = '', previousBanner = '';
  input.addEventListener('input', () => { if (currentId) drafts.set(currentId, input.value); });
  composer.addEventListener('submit', event => {
    event.preventDefault();
    if (!currentId) return;
    try { queue.enqueue(currentId, input.value); input.value = ''; drafts.delete(currentId); toast('Message added to the queue.'); input.focus(); } catch (error) { toast(error.message, true); }
  });
  submitShortcut(input, composer);

  function turnElements(turn, chat) {
    const answer = el('div', { class: 'message-content' });
    const thinkingText = el('div', { class: 'thinking-content' });
    const thinking = el('details', { class: 'thinking-block', hidden: true }, el('summary', { text: 'Model thinking' }), thinkingText);
    const meta = el('div', { class: 'message-meta' });
    const error = el('div', { class: 'notice error', hidden: true });
    const controls = el('div', { class: 'actions' });
    const assistant = el('article', { class: 'message assistant', dataset: { turnId: turn.id } }, el('div', { class: 'message-label', text: 'GUANACO · ASSISTANT' }), thinking, answer, error, meta, controls);
    const user = el('article', { class: 'message user' }, el('div', { class: 'message-label', text: `YOU · ${formatDate(turn.createdAt)}` }), el('div', { class: 'message-content user-content', text: turn.prompt }));
    messages.append(user, assistant);
    return { assistant, user, answer, thinking, thinkingText, meta, error, controls, previousContent: null, previousThinking: null, previousControls: '' };
  }

  function update() {
    const { chats, jobs } = store.state;
    const selected = chats.find(chat => chat.id === context.selectedChatId);
    const signature = JSON.stringify(chats.map(chat => [chat.id, chat.title, chatStatus(chat), chat.configMode, chat.id === selected?.id]));
    if (signature !== previousSidebar) {
      previousSidebar = signature;
      list.replaceChildren(...chats.map(chat => button('', () => openChat(chat.id), `chat-list-item${chat.id === selected?.id ? ' active' : ''}`, { 'aria-current': chat.id === selected?.id ? 'true' : null })));
      [...list.children].forEach((node, i) => node.append(el('strong', { text: chats[i].title }), el('span', {}, badge(statusLabel(chatStatus(chats[i])), chatStatus(chats[i])), configurationBadge(chats[i]))));
      if (!chats.length) list.append(el('p', { class: 'muted', text: 'Your conversations will appear here.' }));
    }
    chatMain.hidden = !selected; empty.hidden = Boolean(selected);
    if (!selected) return;
    if (currentId !== selected.id) {
      if (currentId) drafts.set(currentId, input.value);
      currentId = selected.id; input.value = drafts.get(currentId) || ''; messages.replaceChildren(); rendered.clear();
    }
    title.textContent = selected.title; configBadge.replaceChildren(configurationBadge(selected));
    model.textContent = shortModel(selected.config.model); model.title = selected.config.model;
    const active = selected.turns.find(turn => turn.status === 'running');
    const queued = selected.turns.filter(turn => turn.status === 'queued');
    const firstQueuedJob = queued.length ? jobForTurn(store.state, queued[0].id) : null;
    const bannerText = active ? `Generating a response${queued.length ? ` · ${queued.length} more message${queued.length === 1 ? '' : 's'} queued` : ''}.` : firstQueuedJob ? `Added to queue · Position #${queue.position(firstQueuedJob.id)}${store.state.paused ? ' · Queue is paused' : ' · Waiting for its turn'}.` : 'Ready when you are. Your next message will join the shared queue.';
    if (bannerText !== previousBanner) { banner.textContent = bannerText; previousBanner = bannerText; }
    banner.classList.toggle('is-active', Boolean(active));
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
    const existingCount = rendered.size;
    const welcome = messages.querySelector('.chat-welcome');
    if (!selected.turns.length && !welcome) messages.append(el('div', { class: 'chat-welcome empty-state' }, el('h3', { text: 'Start something good' }), el('p', { text: 'Send a message to start this conversation.' })));
    else if (selected.turns.length && welcome) welcome.remove();
    for (const turn of selected.turns) {
      if (!rendered.has(turn.id)) rendered.set(turn.id, turnElements(turn, selected));
      const nodes = rendered.get(turn.id), job = jobForTurn(store.state, turn.id);
      const content = turn.content || (turn.status === 'running' ? (turn.thinking ? 'Thinking before answering…' : 'Waiting for the model…') : turn.status === 'queued' ? `Waiting in queue${job ? ` · #${queue.position(job.id)}` : ''}` : turn.status === 'completed' ? 'The model returned no answer text. Check thinking output or increase the response limit.' : 'No complete response.');
      if (content !== nodes.previousContent) { nodes.answer.replaceChildren(renderMarkdown(content)); nodes.previousContent = content; }
      if (turn.thinking !== nodes.previousThinking) { nodes.thinkingText.textContent = turn.thinking; nodes.thinking.hidden = !turn.thinking; nodes.previousThinking = turn.thinking; }
      nodes.error.hidden = !turn.error; nodes.error.textContent = turn.error || '';
      const metrics = turn.metrics;
      const details = [statusLabel(turn.status)];
      if (metrics?.eval_count) details.push(`${metrics.eval_count} output tokens`);
      if (metrics?.total_duration) details.push(`${(metrics.total_duration / 1e9).toFixed(1)} s`);
      if (metrics?.done_reason === 'length') details.push('Response limit reached');
      nodes.meta.textContent = details.join(' · ');
      const canRetry = ['failed','cancelled','interrupted'].includes(turn.status) && !selected.turns.slice(selected.turns.indexOf(turn) + 1).some(item => item.status !== 'cancelled') && !selected.turns.some(item => ['running','queued'].includes(item.status));
      const controlsKey = `${turn.status}:${canRetry}:${Boolean(turn.content)}`;
      if (nodes.previousControls !== controlsKey) {
        nodes.controls.replaceChildren(); nodes.previousControls = controlsKey;
        if (['running','queued'].includes(turn.status) && job) nodes.controls.append(button(turn.status === 'running' ? 'Stop generation' : 'Remove from queue', () => queue.cancel(job.id), 'button ghost small'));
        if (canRetry) nodes.controls.append(button('Retry request', () => { try { queue.retry(selected.id, turn.id); toast('Request queued for retry.'); } catch (error) { toast(error.message, true); } }, 'button secondary small'));
        if (turn.content) nodes.controls.append(button('Copy response', async () => { try { await navigator.clipboard.writeText(turn.content); toast('Response copied.'); } catch { toast('Clipboard is unavailable. Select the response text to copy it.', true); } }, 'button ghost small'));
      }
    }
    if (atBottom || existingCount < rendered.size) messages.scrollTop = messages.scrollHeight;
  }
  update();
  return { element: root, update, destroy() {} };
}
