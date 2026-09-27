"""Reading media headers in the background, after the fast directory walk.

The walk only lists names, sizes and dates, so the grid can appear at once.
Dimensions, durations, capture dates and embedded previews need a few reads
inside each file; a small pool of threads does that while the user already
browses, and each result reaches the clients with the next revision.
"""
import queue
import threading

from ..lib.filetimes import birth_time
from ..media.probe import probe

_STOP = object()


class Prober:
    def __init__(self, catalog, workers=4, cancelled=lambda: False):
        self.catalog = catalog
        self.cancelled = cancelled
        self.tasks = queue.Queue()
        self.lock = threading.Lock()
        self.total = 0
        self.done = 0
        self.idle = threading.Event()
        self.idle.set()
        # Probing competes with the directory walk for the interpreter lock, so
        # while the album is being scanned only one worker runs at a time.
        self.limit = max(1, workers)
        self.active = 0
        self.gate = threading.Condition()
        self.threads = [
            threading.Thread(target=self._work, name='lurker-probe-%d' % index, daemon=True)
            for index in range(max(1, workers))
        ]
        for thread in self.threads:
            thread.start()

    def enqueue(self, items):
        with self.lock:
            self.total += len(items)
            self.idle.clear()
        for item in items:
            self.tasks.put((item.id, item.version))

    def set_parallelism(self, limit):
        with self.gate:
            self.limit = max(1, min(limit, len(self.threads)))
            self.gate.notify_all()

    def progress(self):
        with self.lock:
            return {'done': self.done, 'total': self.total}

    def stop(self):
        for _ in self.threads:
            self.tasks.put(_STOP)

    def _work(self):
        while True:
            task = self.tasks.get()
            if task is _STOP:
                return
            with self.gate:
                while self.active >= self.limit:
                    self.gate.wait()
                self.active += 1
            try:
                if not self.cancelled():
                    self._probe_one(*task)
            finally:
                with self.gate:
                    self.active -= 1
                    self.gate.notify()
                with self.lock:
                    self.done += 1
                    if self.done >= self.total:
                        self.idle.set()

    def _probe_one(self, item_id, version):
        item = self.catalog.get(item_id)
        if item is None or item.version != version:
            return
        path = self.catalog.path_of(item)
        try:
            meta = probe(path, item.fmt)
        except OSError:
            meta = {}
        self.catalog.apply_probe(item_id, version, meta, birth_time(path))
