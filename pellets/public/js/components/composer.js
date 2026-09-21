/**
 * Message composer: text field, attachments and the typing signal.
 *
 * Attachment flow:
 *   picking a file starts its upload immediately -> a chip shows progress ->
 *   sending the message references the finished upload ids.
 * That order means the send itself is instant even for a large video, and the
 * user can keep typing while bytes are still moving.
 *
 * Typing indicator: `typing: true` goes out on the first keystroke and is
 * refreshed while the user keeps typing; `typing: false` goes out on send, on
 * an idle pause, and when the composer is destroyed. The server also expires
 * the flag by itself, so a closed tab never leaves a stuck indicator.
 */
import { el, icon, on, disposer } from '../core/dom.js';
import { fileSize } from '../core/format.js';
import { uploadFile } from '../core/api.js';
import { state } from '../core/state.js';
import { toastError } from './toast.js';

/** How long the "still typing" signal is refreshed for. */
const TYPING_REFRESH_MS = 3000;
/** Idle time after which the client declares it stopped typing. */
const TYPING_IDLE_MS = 2500;

let localIdCounter = 0;

/**
 * @param {object} options
 * @param {string} options.roomId
 * @param {(input: { body: string, attachmentIds: string[] }) => Promise<void>|void} options.onSend
 * @param {(typing: boolean) => void} options.onTyping
 */
export function createComposer({ roomId, onSend, onTyping }) {
  const off = disposer();
  /** @type {{ localId: string, file: File, upload: object|null, state: string, abort: Function, node: HTMLElement }[]} */
  const pending = [];

  let typingActive = false;
  let typingRefreshTimer = null;
  let typingIdleTimer = null;
  let sending = false;

  // --- Elements ------------------------------------------------------------

  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
    onChange: () => {
      addFiles(fileInput.files);
      fileInput.value = ''; // allow picking the same file twice in a row
    },
  });

  const pendingList = el('div', { class: 'pending-list' });

  const textarea = el('textarea', {
    class: 'textarea',
    rows: '1',
    placeholder: 'Write a message',
    'aria-label': 'Message',
    maxlength: String(state.limits.maxMessageLength || 4000),
  });

  const attachButton = el(
    'button',
    {
      class: 'btn btn-ghost btn-icon',
      type: 'button',
      title: 'Attach a file',
      'aria-label': 'Attach a file',
      onClick: () => fileInput.click(),
    },
    icon('clip'),
  );

  const sendButton = el(
    'button',
    { class: 'btn btn-primary btn-icon', type: 'submit', title: 'Send', 'aria-label': 'Send message', disabled: true },
    icon('send'),
  );

  const form = el(
    'form',
    { class: 'composer', onSubmit: (event) => { event.preventDefault(); submit(); } },
    pendingList,
    el('div', { class: 'composer-row' }, attachButton, el('div', { class: 'composer-input' }, textarea), sendButton),
    fileInput,
  );

  // --- Text field behaviour -------------------------------------------------

  /** Grow the textarea with its content, up to the CSS max-height. */
  function autoGrow() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  function refreshSendState() {
    const hasText = textarea.value.trim().length > 0;
    const hasReadyAttachment = pending.some((item) => item.state === 'done');
    const uploading = pending.some((item) => item.state === 'uploading');
    sendButton.disabled = sending || uploading || (!hasText && !hasReadyAttachment);
  }

  off(
    on(textarea, 'input', () => {
      autoGrow();
      refreshSendState();
      signalTyping();
    }),
  );

  off(
    on(textarea, 'keydown', (event) => {
      // Enter sends; Shift+Enter (and IME composition) inserts a newline.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    }),
  );

  // Pasting an image straight into the composer attaches it.
  off(
    on(textarea, 'paste', (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    }),
  );

  // --- Typing signal --------------------------------------------------------

  function signalTyping() {
    if (!typingActive) {
      typingActive = true;
      onTyping(true);
      typingRefreshTimer = setInterval(() => onTyping(true), TYPING_REFRESH_MS);
    }
    clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function stopTyping() {
    clearTimeout(typingIdleTimer);
    clearInterval(typingRefreshTimer);
    typingRefreshTimer = null;
    if (!typingActive) return;
    typingActive = false;
    onTyping(false);
  }

  // --- Attachments ----------------------------------------------------------

  /**
   * Queue files and start uploading them right away.
   * @param {FileList|File[]} files
   */
  function addFiles(files) {
    const list = [...(files || [])];
    if (list.length === 0) return;

    const limit = state.limits.maxAttachmentsPerMessage || 10;
    const room = limit - pending.length;
    if (room <= 0) {
      toastError(`You can attach at most ${limit} files to one message.`);
      return;
    }

    for (const file of list.slice(0, room)) startUpload(file);
    if (list.length > room) toastError(`Only the first ${room} file(s) were attached.`);
  }

  function startUpload(file) {
    localIdCounter += 1;
    const localId = `p${localIdCounter}`;

    const bar = el('span', { class: 'pending-bar', style: { width: '0%' } });
    const label = el('span', { class: 'pending-name truncate', text: file.name });
    const thumb = file.type.startsWith('image/')
      ? el('img', { class: 'pending-thumb', src: URL.createObjectURL(file), alt: '' })
      : null;

    const item = {
      localId,
      file,
      upload: null,
      state: 'uploading',
      abort: () => {},
      node: null,
    };

    const removeButton = el(
      'button',
      {
        class: 'pending-remove',
        type: 'button',
        title: 'Remove attachment',
        'aria-label': `Remove ${file.name}`,
        onClick: () => removePending(localId),
      },
      icon('close'),
    );

    const node = el(
      'div',
      { class: 'pending', dataset: { state: 'uploading' }, title: `${file.name} · ${fileSize(file.size)}` },
      thumb,
      label,
      removeButton,
      bar,
    );
    item.node = node;
    pending.push(item);
    pendingList.appendChild(node);
    refreshSendState();

    const { promise, abort } = uploadFile(file, {
      roomId,
      onProgress: (fraction) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
      },
    });
    item.abort = abort;

    promise
      .then((upload) => {
        item.upload = upload;
        item.state = 'done';
        node.dataset.state = 'done';
        bar.style.width = '100%';
        bar.style.opacity = '0';
        refreshSendState();
      })
      .catch((error) => {
        if (error.code === 'aborted') return; // the user removed it on purpose
        item.state = 'error';
        node.dataset.state = 'error';
        label.textContent = `${file.name} — failed`;
        toastError(error);
        refreshSendState();
      });
  }

  function removePending(localId) {
    const index = pending.findIndex((item) => item.localId === localId);
    if (index === -1) return;
    const [item] = pending.splice(index, 1);
    try {
      item.abort();
    } catch {
      /* already finished */
    }
    // Release the object URL created for an image preview.
    const image = item.node.querySelector('img');
    if (image && image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
    item.node.remove();
    refreshSendState();
  }

  function clearPending() {
    for (const item of [...pending]) removePending(item.localId);
  }

  // --- Sending --------------------------------------------------------------

  async function submit() {
    if (sending) return;
    const body = textarea.value.trim();
    const ready = pending.filter((item) => item.state === 'done');
    const uploading = pending.some((item) => item.state === 'uploading');

    if (uploading) {
      toastError('Wait for the attachments to finish uploading.');
      return;
    }
    if (!body && ready.length === 0) return;

    sending = true;
    refreshSendState();
    stopTyping();

    try {
      await onSend({ body, attachmentIds: ready.map((item) => item.upload.id) });
      textarea.value = '';
      autoGrow();
      clearPending();
    } catch (error) {
      toastError(error);
    } finally {
      sending = false;
      refreshSendState();
      textarea.focus();
    }
  }

  return {
    element: form,
    addFiles,
    focus: () => textarea.focus(),
    /** Disable the composer, e.g. while the socket is down. */
    setEnabled(enabled) {
      textarea.disabled = !enabled;
      attachButton.disabled = !enabled;
      refreshSendState();
      if (!enabled) sendButton.disabled = true;
    },
    destroy() {
      stopTyping();
      clearPending();
      off.dispose();
    },
  };
}
