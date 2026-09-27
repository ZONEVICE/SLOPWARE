"""From a parsed request to a written response: guard, route, errors."""
import logging
import socket
import ssl

from ..domain.errors import AppError
from .guard import Guard
from .request import Request
from .respond import STREAMED, Response, send
from .router import Router
from .routes import ROUTE_PLUGINS

log = logging.getLogger('lurker.http')


class WebApp:
    def __init__(self, services, verbose=False):
        self.services = services
        self.verbose = verbose
        self.router = Router()
        for register in ROUTE_PLUGINS:
            register(self.router, services)
        self.guard = Guard(services.auth, services.identity.machine_names())

    def handle(self, handler):
        request = Request(handler, https=self.services.identity.protocol == 'https')
        try:
            try:
                route, params = self.router.match(request.method, request.segments)
                missing = None
            except AppError as error:
                route, params, missing = None, None, error
            # The guard runs for unknown paths too, so a locked Lurker does not
            # reveal which URLs exist.
            refusal = self.guard.check(request, route)
            if refusal is not None:
                response = refusal
            elif missing is not None:
                raise missing
            else:
                response = route.handler(request, **params)
        except AppError as error:
            if request.streaming:
                handler.close_connection = True
                return
            response = Response.json(error.as_dict(), error.status)
        except (ConnectionError, ssl.SSLError, socket.timeout):
            handler.close_connection = True
            return
        except Exception:
            log.exception('Error while serving %s %s', request.method, request.path)
            if request.streaming:
                handler.close_connection = True
                return
            response = Response.json({'error': {'code': 'internal', 'message': 'Something went wrong in Lurker.'}}, 500)
        if response is STREAMED:
            return
        self._send(handler, request, response)

    def _send(self, handler, request, response):
        request.discard_body()
        try:
            send(handler, request, response)
        except (ConnectionError, ssl.SSLError, socket.timeout):
            handler.close_connection = True

    def log_access(self, handler, message):
        if self.verbose:
            log.info('%s %s', handler.client_address[0] if handler.client_address else '-', message)
