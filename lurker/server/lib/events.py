"""A tiny synchronous publish/subscribe bus.

This is the seam between the rules and the outside world: the album service
announces what happened and never calls a transport. The server-sent-events
hub, the console reporter and anything added later subscribe here, so a new
listener never requires editing the code that publishes.
"""
import logging
import threading

log = logging.getLogger('lurker.events')

# Every event name lives here; never publish a string literal.
ALBUM_CHANGED = 'album.changed'      # payload: None. Read album.status() for the new state.
ALBUM_OPENED = 'album.opened'        # payload: {'id', 'root'}
ALBUM_CLOSED = 'album.closed'        # payload: {'id', 'root'}
SCAN_FINISHED = 'scan.finished'      # payload: {'id', 'root', 'items', 'dirs', 'seconds', 'rescan'}
PROBE_FINISHED = 'probe.finished'    # payload: {'id', 'items', 'seconds'}
SESSION_ENDED = 'session.ended'      # payload: {'token'}


class EventBus:
    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers = {}

    def subscribe(self, name, callback):
        """Call `callback(payload)` on every `name` event. Returns an unsubscribe function."""
        with self._lock:
            self._subscribers.setdefault(name, []).append(callback)

        def unsubscribe():
            with self._lock:
                callbacks = self._subscribers.get(name, [])
                if callback in callbacks:
                    callbacks.remove(callback)

        return unsubscribe

    def publish(self, name, payload=None):
        with self._lock:
            callbacks = list(self._subscribers.get(name, ()))
        for callback in callbacks:
            try:
                callback(payload)
            except Exception:  # one broken listener must not silence the others
                log.exception('Listener for %s failed', name)
