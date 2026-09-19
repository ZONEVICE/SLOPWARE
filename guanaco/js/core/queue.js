import { configSnapshot } from './config.js';
import { streamChat } from './api.js';
import { createId } from './store.js';

const PENDING = new Set(['queued', 'running']);

/**
 * The application owns FIFO scheduling; never send queued prompts to Ollama.
 * Only this module starts generation. The active slot is released in finally,
 * after the streaming client settles, including cancellation cleanup.
 * Web Locks also serialize generation between same-origin Guanaco tabs. Where
 * Web Locks is unavailable, serialization is scoped to this page instance.
 */
export class RequestQueue {
  constructor(store, client = streamChat) {
    this.store = store;
    this.client = typeof client === 'function' ? client : client.streamChat;
    this.currentJobId = null;
    this.controller = null;
    this.scheduled = false;
  }

  get activeJobId() { return this.currentJobId; }

  enqueue(chatId, prompt) {
    const chat = this.store.state.chats.find(item => item.id === chatId);
    if (!chat) throw new Error('Chat was not found.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a message first.');
    if (prompt.length > 1000000) throw new Error('Messages must be at most 1,000,000 characters.');
    const turn = {
      id: createId('turn'),
      prompt: prompt.trim(),
      content: '',
      thinking: '',
      status: 'queued',
      error: '',
      createdAt: new Date().toISOString(),
      metrics: null,
    };
    chat.turns.push(turn);
    if (chat.turns.length === 1) chat.title = turn.prompt.replace(/\s+/g, ' ').slice(0, 72);
    return this.addJob(chat, turn);
  }

  addJob(chat, turn) {
    const job = {
      id: createId('job'),
      chatId: chat.id,
      turnId: turn.id,
      config: configSnapshot(chat.config),
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.store.state.jobs.push(job);
    this.store.save();
    this.store.notify();
    this.schedule();
    return job;
  }

  position(jobId) {
    const index = this.store.state.jobs.filter(job => job.status === 'queued').findIndex(job => job.id === jobId);
    return index === -1 ? 0 : index + 1;
  }

  setPaused(paused) {
    this.store.state.paused = Boolean(paused);
    this.store.save();
    this.store.notify();
    if (!paused) this.schedule();
  }

  cancel(jobId) {
    const job = this.store.state.jobs.find(item => item.id === jobId);
    if (!job || !PENDING.has(job.status)) return false;
    if (job.id === this.currentJobId) {
      // Keep status running until the transport has settled: the queue slot
      // must not be freed merely because AbortController.abort() was called.
      job.cancelling = true;
      this.controller.abort();
    } else {
      this.finish(job, 'cancelled', 'Request cancelled before it started.');
    }
    this.store.save();
    this.store.notify();
    return true;
  }

  retry(chatId, turnId) {
    const chat = this.store.state.chats.find(item => item.id === chatId);
    const turnIndex = chat?.turns.findIndex(item => item.id === turnId) ?? -1;
    if (!chat || turnIndex < 0) throw new Error('The message to retry was not found.');
    const turn = chat.turns[turnIndex];
    if (!['failed', 'cancelled', 'interrupted'].includes(turn.status)) {
      throw new Error('Only failed, cancelled, or interrupted messages can be retried.');
    }
    if (this.store.state.jobs.some(job => job.chatId === chatId && PENDING.has(job.status))) {
      throw new Error('Wait for or cancel this chat’s pending requests before retrying.');
    }
    if (chat.turns.slice(turnIndex + 1).some(item => item.status !== 'cancelled')) {
      throw new Error('Only the latest conversation turn can be retried. Start a new message to preserve later history.');
    }
    Object.assign(turn, { content: '', thinking: '', error: '', metrics: null, status: 'queued' });
    return this.addJob(chat, turn);
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.runNext();
    });
  }

  finish(job, status, error = '') {
    job.status = status;
    delete job.cancelling;
    delete job.waitingForLock;
    const chat = this.store.state.chats.find(item => item.id === job.chatId);
    const turn = chat?.turns.find(item => item.id === job.turnId);
    if (turn) Object.assign(turn, { status, error });
  }

  async runNext() {
    if (this.currentJobId || this.store.state.paused) return;
    const job = this.store.state.jobs.find(item => item.status === 'queued');
    if (!job) return;
    const chat = this.store.state.chats.find(item => item.id === job.chatId);
    const turn = chat?.turns.find(item => item.id === job.turnId);
    if (!chat || !turn) {
      this.finish(job, 'failed', 'The conversation for this request is missing.');
      this.store.notify();
      this.schedule();
      return;
    }
    this.currentJobId = job.id;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    job.status = turn.status = 'running';
    this.store.save();
    this.store.notify();
    try {
      const generate = async () => {
        if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
        delete job.waitingForLock;
        this.store.notify();
        const messages = [];
        if (job.config.systemPrompt) messages.push({ role: 'system', content: job.config.systemPrompt });
        // Resolve history at execution time so earlier queued turns in the same
        // chat have a chance to finish. Failed/partial/future turns stay out.
        for (const previous of chat.turns) {
          if (previous.id === turn.id) break;
          if (previous.status === 'completed') {
            messages.push({ role: 'user', content: previous.prompt });
            messages.push({ role: 'assistant', content: previous.content });
          }
        }
        messages.push({ role: 'user', content: turn.prompt });
        turn.metrics = await this.client(job.config, messages, {
          signal,
          onChunk: delta => {
            if (signal.aborted) return;
            turn.content += delta.content || '';
            turn.thinking += delta.thinking || '';
            this.store.notify();
          },
        });
      };
      if (globalThis.navigator?.locks?.request) {
        job.waitingForLock = true;
        this.store.notify();
        await navigator.locks.request('guanaco.ollama.generation.v1', { mode: 'exclusive', signal }, generate);
      } else {
        await generate();
      }
      this.finish(job, signal.aborted ? 'cancelled' : 'completed', signal.aborted ? 'Request cancelled.' : '');
    } catch (error) {
      this.finish(job, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'Request cancelled.' : String(error.message || error));
    } finally {
      this.currentJobId = null;
      this.controller = null;
      this.store.save();
      this.store.notify();
      this.schedule();
    }
  }
}
