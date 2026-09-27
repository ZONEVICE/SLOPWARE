"""The parts of an incoming request the routes use."""
import json
from urllib.parse import parse_qs, unquote, urlsplit

from ..domain.errors import AppError

MAX_BODY = 1024 * 1024


class Request:
    def __init__(self, handler, https=False):
        self.handler = handler
        self.method = handler.command
        self.https = https
        parts = urlsplit(handler.path)
        self.raw_path = parts.path or '/'
        # Each segment is decoded on its own, so an encoded "/" never splits a segment.
        self.segments = [unquote(segment) for segment in self.raw_path.split('/')[1:]]
        self.path = '/' + '/'.join(self.segments)
        self.query = parse_qs(parts.query, keep_blank_values=True)
        self.headers = handler.headers
        self.client_ip = handler.client_address[0] if handler.client_address else ''
        self.cookies = _parse_cookies(self.headers.get('Cookie', ''))
        self.session_token = None
        self.streaming = False
        self._body = None

    def arg(self, name, default=None):
        values = self.query.get(name)
        return values[0] if values else default

    def header(self, name, default=None):
        return self.headers.get(name, default)

    @property
    def user_agent(self):
        return self.headers.get('User-Agent', '')

    @property
    def content_length(self):
        try:
            return max(0, int(self.headers.get('Content-Length', 0) or 0))
        except ValueError:
            raise AppError(400, 'bad_length', 'Content-Length is not a number.') from None

    def body(self, limit=MAX_BODY):
        if self._body is None:
            if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
                self.handler.close_connection = True
                raise AppError(411, 'length_required', 'Send the body with a Content-Length.')
            length = self.content_length
            if length > limit:
                self.handler.close_connection = True
                raise AppError(413, 'too_large', 'The request body is too large.')
            self._body = self.handler.rfile.read(length) if length else b''
        return self._body

    def json(self):
        kind = self.headers.get('Content-Type', '').split(';')[0].strip().lower()
        if kind != 'application/json':
            raise AppError(415, 'json_required', 'Send the body as application/json.')
        try:
            data = json.loads(self.body().decode('utf-8') or '{}')
        except (UnicodeDecodeError, ValueError):
            raise AppError(400, 'bad_json', 'The body is not valid JSON.') from None
        if not isinstance(data, dict):
            raise AppError(400, 'bad_json', 'The body must be a JSON object.')
        return data

    def form(self):
        try:
            text = self.body(limit=64 * 1024).decode('utf-8')
        except UnicodeDecodeError:
            raise AppError(400, 'bad_form', 'The form is not valid UTF-8.') from None
        return {key: values[0] for key, values in parse_qs(text, keep_blank_values=True).items()}

    def discard_body(self):
        """Read an unread body so the next request on this connection starts cleanly."""
        if self._body is not None or self.method in ('GET', 'HEAD'):
            return
        try:
            self.body()
        except AppError:
            self.handler.close_connection = True


def _parse_cookies(header):
    cookies = {}
    for part in header.split(';'):
        if '=' in part:
            name, value = part.split('=', 1)
            cookies.setdefault(name.strip(), value.strip().strip('"'))
    return cookies
