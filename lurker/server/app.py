"""Wiring: build every service, bind the port, and run.

This is the only module that knows every layer. Tests build a LurkerApp
exactly as the command line does, usually with port 0 and a temporary
certificate directory.
"""
import logging
import threading
from types import SimpleNamespace

from . import read_version
from .domain.album import AlbumService
from .domain.auth import Auth
from .domain.previews import Previews
from .lib import cert, events, netinfo
from .lib.events import EventBus
from .lib.listen import bind_first_free
from .web.dispatch import WebApp
from .web.server import LurkerHTTPServer
from .web.sse import SseHub
from .web.static import StaticFiles

log = logging.getLogger('lurker')


class Identity:
    """What this process is: shown in the page footer and the startup banner."""

    def __init__(self, config, version):
        self.protocol = config.protocol
        self.version = version
        self.hostname = netinfo.hostname()
        self.bind_host = config.host
        self.auth = bool(config.password)
        self.port = None

    def machine_names(self):
        name = self.hostname.lower()
        return {name, name.split('.')[0], name.split('.')[0] + '.local', 'localhost'}

    def urls(self):
        """(local URL, [LAN URLs]) for the actual port."""
        scheme = self.protocol
        if self.bind_host in ('0.0.0.0', '', '::'):
            local = '%s://localhost:%d' % (scheme, self.port)
            lan = ['%s://%s:%d' % (scheme, address, self.port) for address in netinfo.lan_addresses(False)]
        else:
            host = '[%s]' % self.bind_host if ':' in self.bind_host else self.bind_host
            local = '%s://%s:%d' % (scheme, host, self.port)
            lan = []
        return local, lan

    def as_dict(self):
        local, lan = self.urls()
        return {'name': 'Lurker', 'version': self.version, 'protocol': self.protocol, 'port': self.port,
                'hostname': self.hostname, 'auth': self.auth, 'url': local, 'lan': lan}


class LurkerApp:
    def __init__(self, config):
        self.config = config
        self.bus = EventBus()
        self.identity = Identity(config, read_version())
        self.album = AlbumService(self.bus, probe_workers=config.probe_workers)
        self.auth = Auth(config.password, self.bus)
        self.hub = SseHub(self.bus, self.album.status)
        self.services = SimpleNamespace(
            config=config, bus=self.bus, identity=self.identity, album=self.album, auth=self.auth,
            previews=Previews(), hub=self.hub, static=StaticFiles(),
        )
        self.web = WebApp(self.services, verbose=config.verbose)
        self.server = None
        self.certificate = None
        self.initial_check = None
        self.busy_ports = []
        self._thread = None
        self._subscribe_reporter()

    def start(self):
        """Mint the certificate (HTTPS), bind the first free port, open `dir`."""
        context = None
        if self.config.https:
            dns, ips = netinfo.certificate_names(self.config.host)
            self.certificate = cert.generate(self.config.cert_dir, self.identity.hostname.split('.')[0] or 'lurker',
                                             dns, ips)
            context = cert.server_context(self.certificate)
        self.server = bind_first_free(
            lambda port: LurkerHTTPServer((self.config.host, port), self.web, context),
            self.config.port, self.config.port_attempts, on_busy=self.busy_ports.append)
        self.identity.port = self.server.server_address[1]
        # Cookies ignore ports, so two instances on one machine need different names.
        self.auth.cookie_name = 'lurker_%d' % self.identity.port
        if self.config.directory:
            self.initial_check = self.album.open_initial(self.config.directory)
        return self

    def serve_forever(self):
        # The poll interval is how long shutdown() may wait for the loop to notice.
        self.server.serve_forever(poll_interval=0.1)

    def start_in_background(self):
        self._thread = threading.Thread(target=self.serve_forever, name='lurker-http', daemon=True)
        self._thread.start()
        return self

    def close(self):
        self.hub.close_all()
        self.album.shutdown()
        if self.server is None:
            return
        if self._thread is not None:
            self.server.shutdown()
            self._thread.join(5)
        self.server.close_connections()
        self.server.server_close()

    @property
    def port(self):
        return self.identity.port

    def _subscribe_reporter(self):
        def scanned(payload):
            log.info('%s %s: %d item%s in %d folder%s (%.1f s)%s', 'Rescanned' if payload['rescan'] else 'Scanned',
                     payload['root'], payload['items'], '' if payload['items'] == 1 else 's', payload['folders'],
                     '' if payload['folders'] == 1 else 's', payload['seconds'],
                     ', %d unreadable folder(s) skipped' % payload['skipped'] if payload['skipped'] else '')

        self.bus.subscribe(events.ALBUM_OPENED, lambda payload: log.info('Album opened: %s', payload['root']))
        self.bus.subscribe(events.ALBUM_CLOSED, lambda payload: log.info('Album closed: %s', payload['root']))
        self.bus.subscribe(events.SCAN_FINISHED, scanned)
        self.bus.subscribe(events.PROBE_FINISHED, lambda payload: log.info(
            'Read the headers of %d file%s', payload['items'], '' if payload['items'] == 1 else 's'))
