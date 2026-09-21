/**
 * ROOM VIEW (window 2 of 3).
 *
 * Joining the room asks the server for its full history, so a client that was
 * not around when earlier messages were sent still sees every one of them.
 *
 * Lifecycle:
 *   mount   -> require a username -> room:join -> render history + members
 *   live    -> message:new, presence:state, typing:state, room:deleted
 *   unmount -> room:leave, stop typing, release listeners
 *
 * Reconnects re-join automatically, because a dropped socket loses its
 * server-side presence.
 */
import { el, icon, on, render, disposer, applyHue } from '../core/dom.js';
import { pluralize } from '../core/format.js';
import { state, subscribe, getRoom, upsertRoom, rememberUser, selfId, isIdentified, userOf } from '../core/state.js';
import { request, send, onFrame, isOpen } from '../core/socket.js';
import { createMessageList } from '../components/messageList.js';
import { createComposer } from '../components/composer.js';
import { avatar } from '../components/avatar.js';
import { confirmModal } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { promptForIdentity } from '../components/identity.js';

/** Distance from the bottom, in px, still considered "at the bottom". */
const STICK_THRESHOLD = 120;

export function roomView({ params, outlet, navigate }) {
  const off = disposer();
  const roomId = params.id;

  let joined = false;
  let destroyed = false;
  /** @type {object[]} */
  let members = [];

  // --- Skeleton --------------------------------------------------------------

  const titleNode = el('div', { class: 'room-head-name truncate', text: getRoom(roomId)?.name || 'Loading room…' });
  const subtitleNode = el('div', { class: 'room-head-sub truncate', text: '' });
  const headActions = el('div', { class: 'row' });

  const head = el(
    'header',
    { class: 'room-head' },
    el(
      'a',
      { class: 'btn btn-ghost btn-icon room-back', href: '/', title: 'Back to rooms', 'aria-label': 'Back to rooms' },
      icon('back'),
    ),
    el('div', { class: 'room-head-text grow' }, titleNode, subtitleNode),
    headActions,
  );

  const scroller = el('div', { class: 'room-scroll' });
  const messageList = createMessageList({ container: scroller });

  const typingText = el('span', { class: 'truncate' });
  const typingNode = el(
    'div',
    { class: 'typing', 'aria-live': 'polite' },
    el('span', { class: 'typing-dots' }, el('i'), el('i'), el('i')),
    typingText,
  );

  const memberListNode = el('div', { class: 'stack' });
  const memberCountNode = el('div', { class: 'side-title', text: 'In this room' });
  const side = el('aside', { class: 'room-side' }, el('div', { class: 'side-section' }, memberCountNode, memberListNode));

  const composer = createComposer({
    roomId,
    onSend: sendMessage,
    onTyping: (typing) => send('typing:set', { roomId, typing }),
  });

  const jumpButton = el(
    'button',
    {
      class: 'btn btn-sm jump-latest',
      type: 'button',
      hidden: true,
      onClick: () => scrollToBottom('smooth'),
    },
    el('span', { text: 'Jump to latest' }),
  );

  const composeArea = el('div', { class: 'room-compose' }, jumpButton, typingNode, composer.element);

  const container = el('section', { class: 'room' }, head, scroller, composeArea, side);
  outlet.appendChild(container);

  // --- Scroll management -----------------------------------------------------

  function atBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD;
  }

  function scrollToBottom(behavior = 'auto') {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    jumpButton.hidden = true;
  }

  off(
    on(scroller, 'scroll', () => {
      if (atBottom()) jumpButton.hidden = true;
    }),
  );

  // --- Header ----------------------------------------------------------------

  function renderHead() {
    const room = getRoom(roomId);
    if (!room) return;

    titleNode.textContent = room.name;
    const parts = [pluralize(room.userCount || 0, 'person', 'people')];
    if (room.topic) parts.unshift(room.topic);
    subtitleNode.textContent = parts.join(' · ');

    render(headActions);
    // The delete control exists only for the session that created the room.
    if (room.createdBy && room.createdBy.id === selfId()) {
      headActions.appendChild(
        el(
          'button',
          {
            class: 'btn btn-danger btn-icon',
            type: 'button',
            title: 'Delete this room',
            'aria-label': 'Delete this room',
            onClick: deleteRoom,
          },
          icon('trash'),
        ),
      );
    }
  }

  function renderMembers() {
    memberCountNode.textContent = `In this room — ${members.length}`;
    render(
      memberListNode,
      members.map((member) => {
        const row = el(
          'div',
          { class: 'member' },
          avatar(member, { size: 'sm' }),
          el('span', { class: 'member-name truncate grow', text: member.displayName || 'Unknown' }),
          member.id === selfId() ? el('span', { class: 'member-you', text: 'you' }) : null,
        );
        return applyHue(row, member.colorHue);
      }),
    );
  }

  /** "Ana is typing", "Ana and Luis are typing", "Several people are typing". */
  function renderTyping(users) {
    const others = (users || []).filter((user) => user.id !== selfId());
    if (others.length === 0) {
      typingNode.classList.remove('is-active');
      typingText.textContent = '';
      return;
    }
    const names = others.map((user) => userOf(user.id, user).displayName || 'Someone');
    let label;
    if (names.length === 1) label = `${names[0]} is typing`;
    else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
    else label = `${names.length} people are typing`;
    typingText.textContent = label;
    typingNode.classList.add('is-active');
  }

  // --- Actions ---------------------------------------------------------------

  async function sendMessage({ body, attachmentIds }) {
    await request('message:send', { roomId, body, attachmentIds });
    scrollToBottom('smooth');
  }

  async function deleteRoom() {
    const room = getRoom(roomId);
    const confirmed = await confirmModal({
      title: `Delete "${room ? room.name : 'this room'}"?`,
      description: 'The room and all of its messages are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete room',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await request('room:delete', { roomId });
    } catch (error) {
      toastError(error);
    }
  }

  /** Join the room and render everything the server sends back. */
  async function join() {
    if (destroyed) return;
    try {
      const payload = await request('room:join', { roomId });
      if (destroyed) return;

      joined = true;
      upsertRoom(payload.room);
      members = payload.members || [];
      for (const member of members) rememberUser(member);
      for (const message of payload.messages || []) rememberUser(message.author);

      renderHead();
      renderMembers();
      renderTyping(payload.typing);

      if (payload.messages && payload.messages.length) messageList.setMessages(payload.messages);
      else messageList.showEmpty();

      // Jump straight to the newest message, without animating through history.
      requestAnimationFrame(() => scrollToBottom('auto'));
      composer.setEnabled(true);
      composer.focus();
    } catch (error) {
      if (destroyed) return;
      if (error.code === 'room_not_found') {
        toast('That room no longer exists.', { tone: 'error' });
        navigate('/', { replace: true });
        return;
      }
      if (error.code === 'identity_required') {
        const ok = await promptForIdentity({
          mandatory: true,
          reason: 'Pick a username to enter this room.',
          onCancel: () => navigate('/', { replace: true }),
        });
        if (ok) join();
        return;
      }
      toastError(error);
    }
  }

  // --- Live frames ------------------------------------------------------------

  off(
    onFrame('message:new', (payload) => {
      if (payload.roomId !== roomId) return;
      rememberUser(payload.message.author);
      const stick = atBottom();
      messageList.append(payload.message);
      if (stick || payload.message.author.id === selfId()) scrollToBottom('smooth');
      else jumpButton.hidden = false;
    }),
  );

  off(
    onFrame('presence:state', (payload) => {
      if (payload.roomId !== roomId) return;
      members = payload.members || [];
      for (const member of members) rememberUser(member);
      renderMembers();
      renderHead();
    }),
  );

  off(
    onFrame('typing:state', (payload) => {
      if (payload.roomId !== roomId) return;
      renderTyping(payload.users);
    }),
  );

  off(
    onFrame('room:deleted', (payload) => {
      if (payload.roomId !== roomId) return;
      joined = false;
      toast(`"${payload.name || 'This room'}" was deleted by its creator.`, { tone: 'error' });
      navigate('/', { replace: true });
    }),
  );

  off(
    onFrame('room:stats', (payload) => {
      if (payload.room.id !== roomId) return;
      renderHead();
    }),
  );

  // A reconnect loses server-side presence, so re-join transparently.
  off(
    onFrame('socket:open', () => {
      if (!destroyed) join();
    }),
  );

  off(subscribe('users', (user) => {
    messageList.repaintUser(user);
    if (members.some((member) => member.id === user.id)) {
      members = members.map((member) => (member.id === user.id ? { ...member, ...user } : member));
      renderMembers();
    }
  }));

  off(
    subscribe('connection', (status) => {
      composer.setEnabled(status === 'online');
    }),
  );

  // --- Drag and drop ----------------------------------------------------------

  let dragDepth = 0;
  off(
    on(container, 'dragenter', (event) => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      container.classList.add('is-dropping');
    }),
  );
  off(
    on(container, 'dragover', (event) => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }),
  );
  off(
    on(container, 'dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) container.classList.remove('is-dropping');
    }),
  );
  off(
    on(container, 'drop', (event) => {
      if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      dragDepth = 0;
      container.classList.remove('is-dropping');
      composer.addFiles(event.dataTransfer.files);
    }),
  );

  // --- Start ------------------------------------------------------------------

  composer.setEnabled(false);
  renderHead();

  (async () => {
    if (!isIdentified()) {
      const ok = await promptForIdentity({
        mandatory: true,
        reason: 'Pick a username to enter this room.',
        onCancel: () => navigate('/', { replace: true }),
      });
      if (!ok || destroyed) return;
    }
    if (isOpen()) join();
    // Otherwise the 'socket:open' frame above joins as soon as we connect.
  })();

  return {
    destroy() {
      destroyed = true;
      composer.destroy();
      if (joined) {
        send('typing:set', { roomId, typing: false });
        send('room:leave', { roomId });
      }
      off.dispose();
    },
  };
}
