"""The optional password (`pass <password>` on the command line).

With a password, every browser must unlock Lurker before anything else is
served. Unlocking creates a session: a random token in a cookie, remembered
only in memory, and bound to the IP address and the User-Agent that unlocked
it. The same cookie presented from another address or another browser/OS is
refused, so each device must type the password itself.

Wrong guesses are throttled per IP address: after a few failures each new
attempt must wait, doubling up to a minute.
"""
import hashlib
import hmac
import secrets
import threading
import time

from ..lib import events
from .errors import AppError

_FREE_FAILURES = 3
_MAX_DELAY = 60.0
_IDLE_EXPIRY = 7 * 24 * 3600


class Session:
    __slots__ = ('token', 'ip', 'agent', 'created', 'seen')

    def __init__(self, token, ip, agent, now):
        self.token, self.ip, self.agent, self.created, self.seen = token, ip, agent, now, now


class Auth:
    def __init__(self, password, bus=None, clock=time.monotonic):
        self._password = password.encode('utf-8') if password else None
        self._bus = bus
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions = {}
        self._failures = {}   # ip -> (count, earliest next attempt)
        self.cookie_name = 'lurker'

    @property
    def enabled(self):
        return self._password is not None

    def login(self, password, ip, user_agent):
        """A new session token, or AppError 401 (wrong) / 429 (too fast)."""
        now = self._clock()
        with self._lock:
            count, not_before = self._failures.get(ip, (0, 0.0))
            if now < not_before:
                wait = int(not_before - now) + 1
                raise AppError(429, 'too_many_attempts',
                               'Too many wrong passwords. Try again in %d second%s.' % (wait, '' if wait == 1 else 's'),
                               retryAfter=wait)
        candidate = (password or '').encode('utf-8')
        # Compare digests so the comparison time does not depend on the password length.
        if not self.enabled or not hmac.compare_digest(hashlib.sha256(candidate).digest(),
                                                        hashlib.sha256(self._password).digest()):
            with self._lock:
                count += 1
                delay = 0.0 if count < _FREE_FAILURES else min(_MAX_DELAY, 2.0 ** (count - _FREE_FAILURES))
                self._failures[ip] = (count, now + delay)
            raise AppError(401, 'wrong_password', 'That password is not correct.')
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._failures.pop(ip, None)
            self._sessions[token] = Session(token, ip, _agent_key(user_agent), now)
            self._expire(now)
        return token

    def check(self, token, ip, user_agent):
        """True when `token` is a live session opened from this IP and this browser."""
        if not self.enabled:
            return True
        if not token:
            return False
        now = self._clock()
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return False
            if now - session.seen > _IDLE_EXPIRY:
                del self._sessions[token]
                return False
            if session.ip != ip or not hmac.compare_digest(session.agent, _agent_key(user_agent)):
                return False
            session.seen = now
            return True

    def logout(self, token):
        with self._lock:
            removed = self._sessions.pop(token, None) is not None
        if removed and self._bus is not None:
            self._bus.publish(events.SESSION_ENDED, {'token': token})
        return removed

    def session_count(self):
        with self._lock:
            return len(self._sessions)

    def _expire(self, now):
        for token in [t for t, s in self._sessions.items() if now - s.seen > _IDLE_EXPIRY]:
            del self._sessions[token]


def _agent_key(user_agent):
    return hashlib.sha256((user_agent or '').encode('utf-8', 'replace')).digest()
