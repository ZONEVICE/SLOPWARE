"""Method + path pattern -> handler.

Patterns are split on "/". A segment is a literal, `{name}`, `{name:int}`, or
a final `{name:path}` that takes every remaining segment. Routes are tried in
registration order, so the static-file catch-all is registered last.
"""
from ..domain.errors import AppError


class Route:
    def __init__(self, method, pattern, handler, public, fallback=False):
        self.method = method
        self.pattern = pattern
        self.handler = handler
        self.public = public
        self.fallback = fallback
        self.parts = [_compile(part) for part in pattern.strip('/').split('/')] if pattern.strip('/') else []

    def match(self, segments):
        params = {}
        if segments == ['']:
            segments = []
        for index, (kind, name) in enumerate(self.parts):
            if kind == 'path':
                rest = segments[index:]
                if not rest or any(segment == '' for segment in rest):
                    return None
                params[name] = '/'.join(rest)
                return params
            if index >= len(segments):
                return None
            segment = segments[index]
            if kind == 'literal':
                if segment != name:
                    return None
            elif kind == 'int':
                if not segment.isdigit() or len(segment) > 12:
                    return None
                params[name] = int(segment)
            else:
                if not segment:
                    return None
                params[name] = segment
        return params if len(segments) == len(self.parts) else None


def _compile(part):
    if part.startswith('{') and part.endswith('}'):
        name, _, kind = part[1:-1].partition(':')
        return (kind or 'text', name)
    return ('literal', part)


class Router:
    def __init__(self):
        self.routes = []

    def add(self, method, pattern, handler, public=False, fallback=False):
        self.routes.append(Route(method, pattern, handler, public, fallback))

    def get(self, pattern, handler, public=False, fallback=False):
        """`fallback`: a catch-all that yields to real routes, even ones for another method."""
        self.add('GET', pattern, handler, public, fallback)

    def post(self, pattern, handler, public=False):
        self.add('POST', pattern, handler, public)

    def match(self, method, segments):
        """(route, params), or AppError 404/405."""
        wanted = 'GET' if method == 'HEAD' else method
        allowed = set()
        fallback = None
        for route in self.routes:
            params = route.match(segments)
            if params is None:
                continue
            if route.fallback:
                if route.method == wanted and fallback is None:
                    fallback = (route, params)
                continue
            if route.method == wanted:
                return route, params
            allowed.add(route.method)
        if allowed:
            raise AppError(405, 'method_not_allowed', 'That method is not allowed here.', allowed=sorted(allowed))
        if fallback is not None:
            return fallback
        raise AppError(404, 'not_found', 'Nothing here.')
