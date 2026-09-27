"""Command-line options.

The specification writes Lurker's options as plain words, so that is the
primary syntax:

    python3 lurker.py https port 8443 dir /srv/photos pass s3cret

The usual dashed spellings work too (`--https`, `--port 8443`, `--port=8443`,
`--dir`, `--pass`), so either habit is fine. The parser is hand-written because
argparse cannot express options without dashes. A value is always the token
that follows its option, taken verbatim: `pass port` sets the password "port".
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

from . import APP_DIR

DEFAULT_PORT = 8080
DEFAULT_HOST = '0.0.0.0'
PORT_ATTEMPTS = 64

USAGE = """\
Usage: python3 lurker.py [https | http] [port <number>] [dir <absolute path>]
                         [pass <password>] [host <address>] [verbose]

  https            Serve over HTTPS (the default). A new self-signed certificate
                   is generated on every start and replaces the one in cert/.
  http             Serve over plain HTTP instead.
  port <number>    First port to try (default 8080). A busy port is not an
                   error: Lurker tries the next one, and the next, and prints
                   the one it got. 0 lets the operating system choose.
  dir <path>       Open this directory as the album right away. When it is not
                   a readable directory, the browser asks for one instead.
  pass <password>  Require this password from every browser before anything
                   else is served.
  host <address>   Address to listen on (default 0.0.0.0, every IPv4 interface).
  verbose          Log every HTTP request.
  help             Show this text.  version  Print the version.

Every option also accepts the dashed form: --https, --port 9000, --port=9000.
"""


class UsageError(ValueError):
    """The command line cannot be understood; the message says why."""


@dataclass
class Config:
    protocol: str = 'https'
    port: int = DEFAULT_PORT
    host: str = DEFAULT_HOST
    directory: Optional[str] = None
    password: Optional[str] = None
    verbose: bool = False
    show_help: bool = False
    show_version: bool = False
    app_dir: str = APP_DIR
    cert_dir: str = field(default_factory=lambda: os.path.join(APP_DIR, 'cert'))
    port_attempts: int = PORT_ATTEMPTS
    probe_workers: int = 4

    @property
    def https(self) -> bool:
        return self.protocol == 'https'


# Option name -> canonical name. Flags take no value; the others take one.
_FLAGS = {
    'http': 'http', 'https': 'https',
    'verbose': 'verbose', 'v': 'verbose',
    'help': 'help', 'h': 'help', '?': 'help',
    'version': 'version',
}
_VALUED = {
    'port': 'port', 'p': 'port',
    'dir': 'dir', 'directory': 'dir', 'd': 'dir',
    'pass': 'pass', 'password': 'pass',
    'host': 'host', 'bind': 'host',
}


def parse_args(argv: List[str], cwd: Optional[str] = None) -> Config:
    """Turn the command-line words into a Config, or raise UsageError."""
    config = Config()
    protocols = []
    tokens = list(argv)
    index = 0
    while index < len(tokens):
        raw = tokens[index]
        index += 1
        name, inline_value = _split(raw)
        if name in _FLAGS:
            if inline_value is not None:
                raise UsageError('"%s" does not take a value.' % raw)
            canonical = _FLAGS[name]
            if canonical in ('http', 'https'):
                protocols.append(canonical)
            elif canonical == 'verbose':
                config.verbose = True
            elif canonical == 'help':
                config.show_help = True
            elif canonical == 'version':
                config.show_version = True
            continue
        if name in _VALUED:
            if inline_value is None:
                if index >= len(tokens):
                    raise UsageError('"%s" needs a value.' % raw)
                inline_value = tokens[index]
                index += 1
            _apply_value(config, _VALUED[name], inline_value, cwd)
            continue
        if os.path.isabs(os.path.expanduser(raw)):
            raise UsageError('Unknown option "%s". To open that directory, write: dir %s' % (raw, raw))
        raise UsageError('Unknown option "%s".' % raw)

    if len(set(protocols)) > 1:
        raise UsageError('Choose either http or https, not both.')
    if protocols:
        config.protocol = protocols[0]
    return config


def _split(raw: str):
    """'--port=80' -> ('port', '80'); 'https' -> ('https', None)."""
    text = raw
    if text.startswith('--'):
        text = text[2:]
    elif text.startswith('-') and len(text) > 1:
        text = text[1:]
    else:
        # A bare word never carries "=value": "pass" "a=b" must stay two tokens.
        return text.lower(), None
    if '=' in text:
        name, value = text.split('=', 1)
        return name.lower(), value
    return text.lower(), None


def _apply_value(config: Config, name: str, value: str, cwd: Optional[str]) -> None:
    if name == 'port':
        try:
            port = int(value, 10)
        except ValueError:
            raise UsageError('The port must be a number, not "%s".' % value) from None
        if not 0 <= port <= 65535:
            raise UsageError('The port must be between 0 and 65535.')
        config.port = port
    elif name == 'dir':
        if not value.strip():
            raise UsageError('The directory cannot be empty.')
        # The browser form insists on absolute paths because the server's
        # working directory means nothing to a remote user. On the command line
        # it does mean something, so a relative path (or ~) is resolved here.
        expanded = os.path.expanduser(value)
        if not os.path.isabs(expanded):
            expanded = os.path.join(cwd or os.getcwd(), expanded)
        config.directory = os.path.normpath(expanded)
    elif name == 'pass':
        if value == '':
            raise UsageError('The password cannot be empty.')
        config.password = value
    elif name == 'host':
        if not value.strip():
            raise UsageError('The host address cannot be empty.')
        config.host = value.strip()
