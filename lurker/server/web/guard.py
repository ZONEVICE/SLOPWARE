"""Who may ask for what, checked before any route runs.

1. Password. When `pass` is set, only the login page and the icon are served
   without a valid session; the API answers 401 and pages redirect to /login.
2. Cross-site writes. A state-changing request must come from Lurker's own
   pages: browsers mark cross-site requests (Sec-Fetch-Site, Origin), and
   JSON routes require a JSON body, which a plain HTML form cannot send.
3. Host names (only without a password). A web page on the Internet could
   point its own domain at this machine's LAN address ("DNS rebinding") and
   read the album from the visitor's browser. That attack needs a public
   domain name in the Host header, so Lurker only answers to IP addresses,
   single-label names, local suffixes (.local, .lan, .home.arpa...) and this
   machine's own name. With a password the session cookie already blocks it.
"""
import ipaddress
from urllib.parse import quote, urlsplit

from .respond import Response

_LOCAL_SUFFIXES = ('.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet',
                   '.localhost', '.private', '.corp')
_API_PREFIXES = ('/api/', '/media/', '/thumb/')


class Guard:
    def __init__(self, auth, machine_names=()):
        self.auth = auth
        self.machine_names = {name.lower().rstrip('.') for name in machine_names if name}

    def check(self, request, route):
        """None to let the request through, or the Response that refuses it."""
        if not self.auth.enabled and not self.host_allowed(request.header('Host')):
            return Response.html(_page('Unknown host name', (
                'Lurker does not answer to this host name. Open it with this computer\'s IP address, '
                'or start Lurker with a password (pass &lt;password&gt;) to use any name.')), 421)
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and not self.same_origin(request):
            return Response.json({'error': {'code': 'cross_site', 'message': 'Cross-site requests are refused.'}}, 403)
        if not self.auth.enabled or (route is not None and route.public):
            return None
        token = request.cookies.get(self.auth.cookie_name)
        if self.auth.check(token, request.client_ip, request.user_agent):
            request.session_token = token
            return None
        if request.path.startswith(_API_PREFIXES):
            return Response.json({'error': {'code': 'auth_required', 'message': 'Enter the password first.'}}, 401)
        if request.method in ('GET', 'HEAD'):
            target = '/login'
            if request.path not in ('/', '/login'):
                target += '?next=' + quote(request.path, safe='/')
            return Response.redirect(target, 303)
        return Response.json({'error': {'code': 'auth_required', 'message': 'Enter the password first.'}}, 401)

    def same_origin(self, request):
        site = request.header('Sec-Fetch-Site')
        if site and site not in ('same-origin', 'none'):
            return False
        origin = request.header('Origin')
        if origin and origin != 'null':
            host = urlsplit(origin).netloc.lower()
            if host != (request.header('Host') or '').lower():
                return False
        return True

    def host_allowed(self, header):
        if not header:
            return True  # HTTP/1.0 clients send none; browsers always do
        host = header.strip().lower()
        if host.startswith('['):
            return True  # an IPv6 literal
        host = host.rsplit(':', 1)[0] if host.count(':') == 1 else host
        host = host.rstrip('.')
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            pass
        if host == 'localhost' or '.' not in host or host in self.machine_names:
            return True
        return host.endswith(_LOCAL_SUFFIXES)


def safe_next(value):
    """Only same-site paths are valid redirect targets after logging in."""
    if not value or not value.startswith('/') or value.startswith('//') or '\\' in value:
        return '/'
    return value


def _page(title, message):
    return ('<!doctype html><html lang="en"><meta charset="utf-8"><title>%s</title>'
            '<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">'
            '<h1>%s</h1><p>%s</p></body></html>') % (title, title, message)
