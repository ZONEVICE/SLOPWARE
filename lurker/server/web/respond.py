"""Responses, and the one function that writes them to the socket."""
import gzip
import json

# A route returns this when it has already written its own response (files, events).
STREAMED = object()

_COMPRESSIBLE = ('application/json', 'text/', 'application/javascript', 'image/svg+xml')

SECURITY_HEADERS = (
    ('X-Content-Type-Options', 'nosniff'),
    ('Referrer-Policy', 'no-referrer'),
    ('X-Frame-Options', 'DENY'),
    ('Cross-Origin-Opener-Policy', 'same-origin'),
    ('Cross-Origin-Resource-Policy', 'same-origin'),
)

# The single-page application. CSSOM changes (element.style.x = ...) are not
# inline styles, so 'unsafe-inline' is not needed; never build HTML strings.
APP_CSP = ("default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; "
           "script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
           "form-action 'self'; frame-ancestors 'none'")

# Files from the album are served with a sandbox: an SVG opened on its own can
# never run script in Lurker's origin.
MEDIA_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"


class Response:
    def __init__(self, status=200, body=b'', content_type=None, headers=None):
        self.status = status
        self.body = body
        self.headers = list(headers or [])
        if content_type:
            self.headers.append(('Content-Type', content_type))

    @classmethod
    def json(cls, data, status=200, headers=None):
        body = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8', 'replace')
        response = cls(status, body, 'application/json; charset=utf-8', headers)
        if not response.header('Cache-Control'):
            response.headers.append(('Cache-Control', 'no-store'))
        return response

    @classmethod
    def html(cls, text, status=200, headers=None):
        return cls(status, text.encode('utf-8'), 'text/html; charset=utf-8', headers)

    @classmethod
    def redirect(cls, location, status=303):
        return cls(status, b'', None, [('Location', location), ('Cache-Control', 'no-store')])

    def header(self, name):
        lowered = name.lower()
        for key, value in self.headers:
            if key.lower() == lowered:
                return value
        return None


def accepts_gzip(request):
    return 'gzip' in request.header('Accept-Encoding', '').lower()


def send(handler, request, response):
    body = response.body or b''
    headers = list(response.headers)
    content_type = response.header('Content-Type') or ''
    if (len(body) > 1024 and content_type.startswith(_COMPRESSIBLE) and not response.header('Content-Encoding')
            and accepts_gzip(request)):
        body = gzip.compress(body, 5)
        headers.append(('Content-Encoding', 'gzip'))
        headers.append(('Vary', 'Accept-Encoding'))
    handler.send_response(response.status)
    present = {key.lower() for key, _ in headers}
    for key, value in SECURITY_HEADERS:
        if key.lower() not in present:
            headers.append((key, value))
    for key, value in headers:
        handler.send_header(key, value)
    handler.send_header('Content-Length', str(len(body)))
    if handler.close_connection:
        handler.send_header('Connection', 'close')
    handler.end_headers()
    if request.method != 'HEAD' and response.status not in (204, 304) and body:
        handler.wfile.write(body)


def send_headers(handler, status, headers):
    """Start a streamed response: status line and headers, with the security set."""
    handler.send_response(status)
    present = {key.lower() for key, _ in headers}
    for key, value in list(headers) + [pair for pair in SECURITY_HEADERS if pair[0].lower() not in present]:
        handler.send_header(key, value)
    handler.end_headers()
