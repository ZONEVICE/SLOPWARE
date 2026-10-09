// WebSocket control channel: auth, reconnect with backoff, heartbeat/latency,
// and coalesced binary mouse movement. All addresses are relative so the app
// works over Wi-Fi, a phone hotspot, Bluetooth PAN or USB tethering unchanged.

import { getToken } from './util.js';

const BIN_MOVE_ABS = 1;
const BIN_MOVE_REL = 2;
const BIN_SCROLL = 3;

export class WsClient {
  constructor({ onEvent, onStatus, onLatency }) {
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLatency = onLatency || (() => {});
    this.ws = null;
    this.backoff = 500;
    this.moveMode = BIN_MOVE_ABS;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingScrollV = 0;
    this.pendingScrollH = 0;
    this.rafScheduled = false;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.authed = false;
  }

  connect() {
    this.stopped = false;
    this._open();
  }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.onStatus(this.backoff === 500 ? 'connecting' : 'reconnecting');
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (e) {
      return this._scheduleReconnect();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.authed = false;
      this.send({ type: 'auth', token: getToken() || '' });
    };
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onclose = () => {
      this.authed = false;
      this._stopHeartbeat();
      if (!this.stopped) this._scheduleReconnect();
      else this.onStatus('closed');
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  _onMessage(ev) {
    if (typeof ev.data !== 'string') return; // server never sends binary
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    switch (msg.type) {
      case 'authOk':
        this.authed = true;
        this.backoff = 500;
        this.onStatus('open');
        this._startHeartbeat();
        this.onEvent('authOk', msg);
        break;
      case 'authFail':
        this.stopped = true;
        this.onEvent('authFail', msg);
        break;
      case 'pong': {
        if (typeof msg.t === 'number') this.onLatency(Math.max(0, Date.now() - msg.t));
        break;
      }
      default:
        this.onEvent(msg.type, msg);
    }
  }

  _scheduleReconnect() {
    this.onStatus('reconnecting');
    setTimeout(() => { if (!this.stopped) this._open(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 8000);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', t: Date.now() });
      }
    }, 3000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  isReady() { return this.ws && this.ws.readyState === WebSocket.OPEN && this.authed; }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  setMoveMode(relative) { this.moveMode = relative ? BIN_MOVE_REL : BIN_MOVE_ABS; }

  // Accumulate movement and flush once per animation frame as one binary frame.
  move(dx, dy) {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this._scheduleFlush();
  }

  scroll(v, h) {
    this.pendingScrollV += v;
    this.pendingScrollH += h;
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => this._flush());
  }

  _flush() {
    this.rafScheduled = false;
    if (!this.isReady()) { this.pendingDx = this.pendingDy = this.pendingScrollV = this.pendingScrollH = 0; return; }
    if (this.pendingDx || this.pendingDy) {
      this._sendBin(this.moveMode, this.pendingDx, this.pendingDy);
      this.pendingDx = 0; this.pendingDy = 0;
    }
    if (this.pendingScrollV || this.pendingScrollH) {
      this._sendBin(BIN_SCROLL, this.pendingScrollV, this.pendingScrollH);
      this.pendingScrollV = 0; this.pendingScrollH = 0;
    }
  }

  _sendBin(type, a, b) {
    const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    const buf = new ArrayBuffer(5);
    const dv = new DataView(buf);
    dv.setUint8(0, type);
    dv.setInt16(1, clampI16(a), true);
    dv.setInt16(3, clampI16(b), true);
    try { this.ws.send(buf); } catch (e) {}
  }

  close() {
    this.stopped = true;
    this._stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }
}
