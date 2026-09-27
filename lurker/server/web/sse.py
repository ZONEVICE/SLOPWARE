"""Server-sent events: every open browser learns about album changes at once.

Each stream holds one thread and one connection. The album announces changes
on the bus; the hub marks every stream "dirty" and each stream sends the
latest album status, at most five times a second, however fast the changes
come. The status carries the catalog revision, and a client that sees a new
revision fetches the delta itself.
"""
import json
import socket
import ssl
import threading
import time

from ..lib import events
from .respond import send_headers

_HEARTBEAT = 15.0
_MIN_INTERVAL = 0.2


class _Stream:
    __slots__ = ('token', 'wake', 'dirty', 'closed')

    def __init__(self, token):
        self.token = token
        self.wake = threading.Event()
        self.dirty = False
        self.closed = False


class SseHub:
    def __init__(self, bus, snapshot, heartbeat=_HEARTBEAT, min_interval=_MIN_INTERVAL):
        self.snapshot = snapshot
        self.heartbeat = heartbeat
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._streams = set()
        bus.subscribe(events.ALBUM_CHANGED, lambda _: self.touch())
        bus.subscribe(events.SESSION_ENDED, lambda payload: self.close_session(payload['token']))

    def count(self):
        with self._lock:
            return len(self._streams)

    def touch(self):
        with self._lock:
            streams = list(self._streams)
        for stream in streams:
            stream.dirty = True
            stream.wake.set()

    def close_session(self, token):
        with self._lock:
            streams = [stream for stream in self._streams if stream.token == token]
        for stream in streams:
            stream.closed = True
            stream.wake.set()

    def close_all(self):
        with self._lock:
            streams = list(self._streams)
        for stream in streams:
            stream.closed = True
            stream.wake.set()

    def serve(self, handler, request):
        stream = _Stream(request.session_token)
        with self._lock:
            self._streams.add(stream)
        request.streaming = True
        # The stream ends when the connection closes, so there is no length.
        handler.close_connection = True
        try:
            send_headers(handler, 200, [
                ('Content-Type', 'text/event-stream; charset=utf-8'),
                ('Cache-Control', 'no-store'),
                ('Connection', 'close'),
                ('X-Accel-Buffering', 'no'),
            ])
            handler.wfile.write(b'retry: 2000\n\n' + self._event())
            last_sent = time.monotonic()
            while not stream.closed:
                woke = stream.wake.wait(self.heartbeat)
                stream.wake.clear()
                if stream.closed:
                    break
                if woke and stream.dirty:
                    pause = self.min_interval - (time.monotonic() - last_sent)
                    if pause > 0:
                        time.sleep(pause)  # changes arriving meanwhile are folded into this event
                    stream.dirty = False
                    handler.wfile.write(self._event())
                    last_sent = time.monotonic()
                elif not woke:
                    handler.wfile.write(b': ping\n\n')
        except (OSError, ssl.SSLError, socket.timeout, ValueError):
            pass  # the browser went away
        finally:
            with self._lock:
                self._streams.discard(stream)

    def _event(self):
        data = json.dumps(self.snapshot(), separators=(',', ':'), ensure_ascii=False)
        return ('event: state\ndata: %s\n\n' % data).encode('utf-8', 'replace')
