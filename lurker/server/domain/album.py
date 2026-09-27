"""The album: the one directory this Lurker instance shows, shared by every browser.

States:

    empty ──open──▶ scanning ──walk done──▶ ready ──rescan──▶ scanning ...
      ▲                 │                     │
      └─────close───────┴────────close────────┘

Only one album is open per process: to look at two directories at once, the
user starts a second Lurker. Every browser sees the same album, so opening or
closing it is announced on the bus and reaches all of them.

While scanning, items become visible directory by directory; header probing
runs behind the walk and keeps going after it. A small committer thread turns
pending catalog changes into revisions at most every `commit_interval`
seconds and announces them, which is what keeps the event stream calm while
tens of thousands of files are registered.
"""
import logging
import secrets
import threading
import time

from ..lib import events
from ..media import probe as media_probe
from . import paths, scanner
from .catalog import Catalog, display_name
from .errors import AppError
from .prober import Prober

log = logging.getLogger('lurker.album')
_RECENT_LIMIT = 8


class AlbumSession:
    def __init__(self, check, workers):
        self.id = secrets.token_hex(6)
        self.root = check.path
        self.real = check.real
        self.name = check.name
        self.opened_at = time.time()
        self.cancel = threading.Event()
        self.catalog = Catalog(self.id, check.real)
        self.status = 'scanning'
        self.scan = scanner.ScanStats()
        self.prober = Prober(self.catalog, workers, self.cancel.is_set)
        self.probe_reported = False
        self.probe_started = time.time()


class AlbumService:
    def __init__(self, bus, probe_workers=4, commit_interval=0.25):
        self.bus = bus
        self.workers = probe_workers
        self.commit_interval = commit_interval
        self.lock = threading.RLock()
        self.session = None
        self.recent = []
        self.notice = None

    # --- commands --------------------------------------------------------------

    def open(self, raw_path):
        check = paths.check_directory(raw_path)
        if not check.ok:
            raise AppError(400, check.code, check.message, path=check.path)
        with self.lock:
            if self.session is not None:
                raise AppError(409, 'album_open', 'An album is already open. Close it before opening another one.',
                               album=self.session.id)
            session = AlbumSession(check, self.workers)
            self.session = session
            self.notice = None
            self._remember(session)
        log.debug('Opened album %s', session.root)
        # Announce the album before its threads start: a small directory can be
        # scanned completely before a later announcement would go out.
        self.bus.publish(events.ALBUM_OPENED, {'id': session.id, 'root': session.root})
        self.bus.publish(events.ALBUM_CHANGED)
        self._start(session)
        return self.status()

    def open_initial(self, directory):
        """Open the directory given on the command line, or explain why not."""
        check = paths.check_directory(directory)
        if not check.ok:
            self.notice = {'path': check.path or directory, 'code': check.code,
                           'message': 'The directory given on the command line could not be opened. ' + check.message}
            return check
        self.open(check.path)
        return check

    def close(self):
        with self.lock:
            session = self.session
            if session is None:
                return self.status()
            self.session = None
            session.cancel.set()
            session.prober.stop()
        log.debug('Closed album %s', session.root)
        self.bus.publish(events.ALBUM_CLOSED, {'id': session.id, 'root': session.root})
        self.bus.publish(events.ALBUM_CHANGED)
        return self.status()

    def rescan(self, album_id=None):
        with self.lock:
            session = self._session(album_id)
            if session.status == 'scanning':
                raise AppError(409, 'busy', 'The album is still being scanned.')
            session.status = 'scanning'
            session.scan = scanner.ScanStats(rescan=True)
            session.probe_reported = False
        threading.Thread(target=self._scan, args=(session,), name='lurker-rescan', daemon=True).start()
        self.bus.publish(events.ALBUM_CHANGED)
        return self.status()

    def shutdown(self):
        with self.lock:
            session, self.session = self.session, None
        if session is not None:
            session.cancel.set()
            session.prober.stop()

    # --- queries -----------------------------------------------------------------

    def status(self):
        with self.lock:
            session = self.session
            if session is None:
                return {'status': 'empty', 'recent': list(self.recent), 'notice': self.notice}
            return {
                'status': session.status,
                'id': session.id,
                'root': session.root,
                'name': session.name,
                'rev': session.catalog.rev,
                'openedAt': session.opened_at,
                'counts': session.catalog.summary(),
                'scan': session.scan.as_dict(),
                'probe': session.prober.progress(),
            }

    def delta(self, album_id, since):
        session = self._session(album_id)
        result = session.catalog.delta(since)
        result['album'] = session.id
        return result

    def resolve(self, album_id, item_id):
        """(item, absolute path) for a media request, or AppError 404."""
        session = self._session(album_id)
        item = session.catalog.get(item_id)
        if item is None:
            raise AppError(404, 'not_found', 'That file is no longer part of the album.')
        return item, session.catalog.path_of(item)

    def details(self, album_id, item_id):
        """Everything known about one item, including EXIF fields read on demand."""
        item, path = self.resolve(album_id, item_id)
        try:
            meta = media_probe.probe(path, item.fmt, detail=True)
        except OSError:
            meta = {}
        folder = display_name(item.folder.rel)
        return {
            'id': item.id,
            'name': display_name(item.name),
            'folder': folder,
            'path': (folder + '/' if folder else '') + item.name,
            'format': item.fmt.key,
            'mime': item.fmt.mime,
            'size': item.size,
            'modified': item.mtime_ns / 1e9,
            'created': item.birth,
            'taken': item.taken,
            'takenUtc': item.taken_utc,
            'width': item.width,
            'height': item.height,
            'duration': item.duration,
            'orientation': item.orientation,
            'camera': item.camera,
            'codec': item.codec,
            'animated': item.animated,
            'details': meta.get('details', {}),
        }

    # --- internals -----------------------------------------------------------------

    def _session(self, album_id):
        with self.lock:
            session = self.session
        if session is None:
            raise AppError(404, 'no_album', 'No album is open.')
        if album_id is not None and album_id != session.id:
            raise AppError(409, 'album_changed', 'The album was closed or replaced.', album=session.id)
        return session

    def _remember(self, session):
        self.recent = [entry for entry in self.recent if entry['path'] != session.root]
        self.recent.insert(0, {'path': session.root, 'name': session.name})
        del self.recent[_RECENT_LIMIT:]

    def _start(self, session):
        threading.Thread(target=self._scan, args=(session,), name='lurker-scan', daemon=True).start()
        threading.Thread(target=self._commit_loop, args=(session,), name='lurker-commit', daemon=True).start()

    def _scan(self, session):
        started = time.time()
        session.prober.set_parallelism(1)
        try:
            finished = scanner.walk(session.catalog, session.scan, session.cancel.is_set, session.prober.enqueue)
        except Exception:  # a bug must not leave the album "scanning" forever
            log.exception('Scanning %s failed', session.root)
            finished = not session.cancel.is_set()
        session.prober.set_parallelism(self.workers)
        if not finished or session.cancel.is_set():
            return
        session.catalog.commit()
        with self.lock:
            session.scan.finished = time.time()
            session.scan.current = ''
            session.status = 'ready'
            session.probe_started = time.time()
        summary = session.catalog.summary()
        self.bus.publish(events.SCAN_FINISHED, {
            'id': session.id, 'root': session.root, 'items': summary['items'], 'folders': summary['folders'],
            'directories': session.scan.directories, 'skipped': session.scan.skipped,
            'seconds': round(time.time() - started, 2), 'rescan': session.scan.rescan,
        })
        self.bus.publish(events.ALBUM_CHANGED)

    def _commit_loop(self, session):
        last = None
        while not session.cancel.wait(self.commit_interval):
            session.catalog.commit()
            progress = session.prober.progress()
            signature = (session.catalog.rev, session.status, session.scan.directories, progress['done'])
            if signature != last:
                last = signature
                self.bus.publish(events.ALBUM_CHANGED)
            if (session.status == 'ready' and not session.probe_reported and session.prober.idle.is_set()
                    and not session.catalog.dirty):
                session.probe_reported = True
                self.bus.publish(events.PROBE_FINISHED, {
                    'id': session.id, 'items': progress['done'],
                    'seconds': round(time.time() - session.probe_started, 2),
                })
