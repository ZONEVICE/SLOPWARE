"""Bind the first free port at or after the preferred one.

A busy port is not an error in this repository: the developer probably has
another instance running, so Lurker walks upwards (8080, 8081, 8082...) until a
bind succeeds. Only "address already in use" moves the walk forward; a
permission error or an address that does not exist on this machine is a real
configuration problem and is raised immediately.
"""
import errno

# Windows reports WSAEADDRINUSE (10048) in winerror, not always in errno.
_IN_USE_WINERRORS = {10048}


class PortsExhausted(OSError):
    def __init__(self, first, last):
        super().__init__(
            errno.EADDRINUSE,
            'No free port between %d and %d. Pass another starting port, for example: port 9000'
            % (first, last))
        self.first = first
        self.last = last


def is_address_in_use(error):
    if getattr(error, 'errno', None) == errno.EADDRINUSE:
        return True
    return getattr(error, 'winerror', None) in _IN_USE_WINERRORS


def bind_first_free(create, preferred, attempts=64, on_busy=None):
    """Return `create(port)` for the first port that is not already in use.

    `create` binds and returns a server (or raises OSError). Port 0 is passed
    through untouched: it already means "any free port".
    """
    if preferred == 0:
        return create(0)
    last = min(65535, preferred + max(1, attempts) - 1)
    for port in range(preferred, last + 1):
        try:
            return create(port)
        except OSError as error:
            if not is_address_in_use(error):
                raise
            if on_busy is not None:
                on_busy(port)
    raise PortsExhausted(preferred, last)
