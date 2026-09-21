/**
 * HOME VIEW (window 1 of 3).
 *
 * Lists every open chat room with its live user count, and lets anyone create
 * new ones without limit. A room with nobody in it stays listed - only its
 * creator can remove it, and the delete control is only rendered for them.
 *
 * The list is driven entirely by the 'rooms' state channel, which the socket
 * frames `rooms:state`, `room:created`, `room:deleted` and `room:stats` feed.
 */
import { el, icon, render, disposer } from '../core/dom.js';
import { relativeTime, pluralize } from '../core/format.js';
import { state, subscribe, roomList, selfId, isIdentified } from '../core/state.js';
import { request } from '../core/socket.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { promptForIdentity } from '../components/identity.js';

export function homeView({ outlet, navigate }) {
  const off = disposer();

  const grid = el('div', { class: 'room-grid' });
  const countLabel = el('p', { class: 'page-subtitle' });

  const newRoomButton = el(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => openCreateRoom() },
    icon('plus'),
    el('span', { text: 'New room' }),
  );

  const page = el(
    'div',
    { class: 'page' },
    el(
      'div',
      { class: 'page-inner' },
      el(
        'div',
        { class: 'page-head' },
        el('div', { class: 'page-title' }, el('h1', { text: 'Chat rooms' }), countLabel),
        newRoomButton,
      ),
      grid,
    ),
  );

  outlet.appendChild(page);

  // --- Rendering ------------------------------------------------------------

  function renderRooms() {
    const rooms = roomList();
    countLabel.textContent = rooms.length
      ? `${pluralize(rooms.length, 'room')} open · everything lives in memory and disappears when the server stops`
      : 'Nothing here yet. Create the first room.';

    if (rooms.length === 0) {
      render(
        grid,
        el(
          'div',
          { class: 'empty' },
          icon('chat', 'empty-icon'),
          el('div', { class: 'empty-title', text: 'No rooms yet' }),
          el('p', { text: 'Create one and share the link. Anyone who opens it just picks a username.' }),
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => openCreateRoom() },
            icon('plus'),
            el('span', { text: 'Create a room' }),
          ),
        ),
      );
      return;
    }

    render(grid, rooms.map(renderRoomCard));
  }

  /**
   * One room card.
   *
   * The card itself is an anchor, and the owner-only delete control sits in a
   * sibling layer positioned over it. Keeping the button OUTSIDE the anchor
   * avoids nesting interactive elements, which browsers and screen readers
   * both handle badly.
   */
  function renderRoomCard(room) {
    const isOwner = room.createdBy && room.createdBy.id === selfId();

    const card = el(
      'a',
      { class: `room-card${isOwner ? ' is-owned' : ''}`, href: `/room/${room.id}` },
      el(
        'div',
        { class: 'room-card-top' },
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'room-card-name truncate', text: room.name }),
          room.topic ? el('div', { class: 'room-card-topic truncate', text: room.topic }) : null,
        ),
        el(
          'span',
          {
            class: `badge${room.userCount > 0 ? ' badge-live' : ''}`,
            title: `${room.userCount} connected`,
          },
          icon('users'),
          el('span', { text: String(room.userCount) }),
        ),
      ),
      room.lastMessage && room.lastMessage.preview
        ? el(
            'div',
            { class: 'room-card-preview' },
            el('b', { text: `${room.lastMessage.authorName || 'Someone'}:` }),
            el('span', { class: 'truncate', text: room.lastMessage.preview }),
          )
        : null,
      el(
        'div',
        { class: 'room-card-meta' },
        el('span', { class: 'row' }, icon('chat'), el('span', { text: pluralize(room.messageCount, 'message') })),
        el('span', { text: '\u00b7' }),
        el('span', { text: relativeTime(room.lastActivityAt || room.createdAt) }),
        isOwner ? el('span', { class: 'badge badge-owner', text: 'Yours' }) : null,
      ),
    );

    if (!isOwner) return card;

    return el(
      'div',
      { class: 'room-card-wrap' },
      card,
      el(
        'button',
        {
          class: 'btn btn-danger btn-icon btn-sm room-card-delete',
          type: 'button',
          title: 'Delete this room',
          'aria-label': `Delete room ${room.name}`,
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteRoom(room);
          },
        },
        icon('trash'),
      ),
    );
  }

  // --- Actions ---------------------------------------------------------------

  /** Creating a room needs a username, so ask for one first if necessary. */
  async function openCreateRoom() {
    if (!isIdentified()) {
      const ok = await promptForIdentity({ reason: 'Pick a username before creating a room.' });
      if (!ok) return;
    }

    const error = el('div', { class: 'field-error', role: 'alert' });
    const nameInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Design, Random, Standup...',
      maxlength: String(state.limits.maxRoomNameLength || 120),
      required: true,
    });
    const topicInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Optional one-line description',
      maxlength: String(state.limits.maxRoomTopicLength || 240),
    });

    const submitButton = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Create room' });

    const form = el(
      'form',
      {
        class: 'stack',
        onSubmit: async (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          if (!name) {
            error.textContent = 'Give the room a name.';
            return;
          }
          submitButton.disabled = true;
          try {
            const payload = await request('room:create', { name, topic: topicInput.value.trim() });
            modal.close();
            navigate(`/room/${payload.room.id}`);
          } catch (failure) {
            error.textContent = failure.message || 'Could not create the room.';
            submitButton.disabled = false;
          }
        },
      },
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Room name' }), nameInput),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Topic' }), topicInput),
      error,
      el('div', { class: 'modal-actions' }, submitButton),
    );

    const modal = openModal({
      title: 'New chat room',
      description: 'Rooms stay open even when empty, and there is no limit on how many you create.',
      content: form,
    });
  }

  /** Delete a room. The server enforces that only the creator may do this. */
  async function deleteRoom(room) {
    const confirmed = await confirmModal({
      title: `Delete "${room.name}"?`,
      description: 'The room and all of its messages are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete room',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await request('room:delete', { roomId: room.id });
      toast('Room deleted.');
    } catch (failure) {
      toastError(failure);
    }
  }

  // --- Wiring ----------------------------------------------------------------

  off(subscribe('rooms', renderRooms));
  off(subscribe('session', renderRooms)); // ownership badges depend on the session
  renderRooms();

  return {
    destroy() {
      off.dispose();
    },
  };
}
