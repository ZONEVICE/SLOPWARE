/**
 * Message list renderer.
 *
 * Behaviour worth knowing before changing it:
 *  - Messages are append-only, exactly like the server model. There is no edit
 *    or delete path anywhere in this file.
 *  - Consecutive messages from the same author within a few minutes are grouped
 *    under one header, which is what makes a busy room readable.
 *  - Author names and colours are read from the LIVE user directory, falling
 *    back to the immutable snapshot stored on each message. A rename therefore
 *    repaints old messages without the server rewriting anything.
 */
import { el, icon, applyHue, clear } from '../core/dom.js';
import { clockTime, dayLabel, linkify } from '../core/format.js';
import { userOf, selfId } from '../core/state.js';
import { avatar } from './avatar.js';
import { renderAttachment } from './attachment.js';

/** Messages closer together than this from the same author are grouped. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {{ container: HTMLElement }} options The scrollable element.
 */
export function createMessageList({ container }) {
  const list = el('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  container.appendChild(list);

  /** @type {object|null} Previous message, for grouping decisions. */
  let previous = null;

  /** Should this message continue the previous one's block? */
  function isGrouped(message) {
    if (!previous) return false;
    if (previous.author.id !== message.author.id) return false;
    if (message.createdAt - previous.createdAt > GROUP_WINDOW_MS) return false;
    return new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
  }

  /** Insert a "Today" / date separator when the day changes. */
  function maybeAddDivider(message) {
    const sameDay =
      previous && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
    if (sameDay) return;
    list.appendChild(el('div', { class: 'day-divider', text: dayLabel(message.createdAt) }));
  }

  /** Message body text, with bare URLs turned into real links. */
  function renderText(body) {
    const node = el('div', { class: 'msg-text' });
    for (const part of linkify(body)) {
      if (part.type === 'link') {
        node.appendChild(
          el('a', {
            href: part.href,
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            'data-external': 'true',
            text: part.value,
          }),
        );
      } else {
        // textContent, never innerHTML: message bodies are untrusted input.
        node.appendChild(document.createTextNode(part.value));
      }
    }
    return node;
  }

  /**
   * Build one message row.
   * @param {object} message
   * @param {boolean} grouped
   */
  function renderMessage(message, grouped) {
    const author = userOf(message.author.id, message.author);
    const mine = message.author.id === selfId();

    const body = el('div', { class: 'msg-body' });
    if (!grouped) {
      body.appendChild(
        el(
          'div',
          { class: 'msg-head' },
          el('span', { class: 'msg-author truncate', 'data-author-name': '', text: author.displayName || 'Unknown' }),
          el('time', {
            class: 'msg-time',
            datetime: new Date(message.createdAt).toISOString(),
            text: clockTime(message.createdAt),
          }),
        ),
      );
    }

    if (message.body) body.appendChild(renderText(message.body));

    if (message.attachments && message.attachments.length) {
      const wrap = el('div', { class: 'attachments' });
      for (const attachment of message.attachments) wrap.appendChild(renderAttachment(attachment));
      body.appendChild(wrap);
    }

    const gutter = el('div', { class: 'msg-gutter' });
    if (grouped) {
      gutter.appendChild(el('span', { class: 'msg-time-inline', text: clockTime(message.createdAt) }));
    } else {
      gutter.appendChild(avatar(author));
    }

    const row = el(
      'article',
      {
        class: `msg${grouped ? ' is-grouped' : ''}${mine ? ' is-self' : ''}`,
        dataset: { messageId: message.id, authorId: message.author.id },
      },
      gutter,
      body,
    );

    return applyHue(row, author.colorHue);
  }

  return {
    element: list,

    /** Replace the whole list, e.g. right after joining a room. */
    setMessages(messages) {
      clear(list);
      previous = null;
      for (const message of messages) this.append(message);
    },

    /**
     * Append one message.
     * @param {object} message
     * @returns {HTMLElement} The rendered row.
     */
    append(message) {
      // Drop the "no messages yet" placeholder as soon as real content arrives.
      const placeholder = list.querySelector(':scope > .empty');
      if (placeholder) placeholder.remove();
      maybeAddDivider(message);
      const grouped = isGrouped(message);
      const node = renderMessage(message, grouped);
      list.appendChild(node);
      previous = message;
      return node;
    },

    /**
     * Repaint every message written by a user whose profile changed.
     * @param {{ id: string, displayName?: string, colorHue?: number }} user
     */
    repaintUser(user) {
      if (!user || !user.id) return;
      const rows = list.querySelectorAll(`.msg[data-author-id="${CSS.escape(user.id)}"]`);
      for (const row of rows) {
        applyHue(row, user.colorHue);
        const nameNode = row.querySelector('[data-author-name]');
        if (nameNode && user.displayName) nameNode.textContent = user.displayName;
        const avatarNode = row.querySelector('.avatar');
        if (avatarNode && user.displayName) {
          const fresh = avatar({ displayName: user.displayName, colorHue: user.colorHue });
          avatarNode.replaceWith(fresh);
        }
      }
    },

    /** Empty-room placeholder. */
    showEmpty() {
      clear(list);
      previous = null;
      list.appendChild(
        el(
          'div',
          { class: 'empty' },
          icon('chat', 'empty-icon'),
          el('div', { class: 'empty-title', text: 'No messages yet' }),
          el('p', { text: 'Say something. Everyone who joins later will see it.' }),
        ),
      );
    },

    /** True when the list is currently empty of real messages. */
    get isEmpty() {
      return previous === null;
    },

    clear() {
      clear(list);
      previous = null;
    },
  };
}
