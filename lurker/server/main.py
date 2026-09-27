"""`python3 lurker.py ...`: parse the options, start, print where to connect."""
import logging
import signal
import sys

from . import read_version
from .app import LurkerApp
from .config import USAGE, UsageError, parse_args
from .lib.listen import PortsExhausted


def main(argv):
    try:
        config = parse_args(argv)
    except UsageError as error:
        print('lurker: %s\n' % error, file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    if config.show_help:
        print(USAGE)
        return 0
    if config.show_version:
        print('Lurker %s' % read_version())
        return 0

    logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(message)s', datefmt='%H:%M:%S')
    app = LurkerApp(config)
    if config.https:
        print('Generating a new self-signed certificate...', flush=True)
    try:
        app.start()
    except PortsExhausted as error:
        print('lurker: %s' % error.strerror, file=sys.stderr)
        return 1
    except OSError as error:
        print('lurker: cannot listen on %s:%d: %s' % (config.host, config.port, error.strerror or error),
              file=sys.stderr)
        return 1

    print_banner(app)

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping Lurker.', flush=True)
    finally:
        app.close()
    return 0


def print_banner(app):
    identity = app.identity
    config = app.config
    local, lan = identity.urls()
    lines = ['', 'Lurker %s is running over %s.' % (identity.version, identity.protocol.upper())]
    if app.busy_ports:
        lines.append('Port %d was busy, so it is using port %d.' % (config.port, identity.port))
    lines += ['', '  This computer   %s' % local]
    for index, url in enumerate(lan):
        lines.append('  %s%s' % ('Other devices   ' if index == 0 else '                ', url))
    lines.append('')
    if config.password:
        lines.append('  Password        required from every browser')
    else:
        lines.append('  Password        none: anyone who can reach these addresses can browse the album')
    if app.certificate:
        lines.append('  Certificate     %s (new, self-signed: browsers warn once)' % app.certificate.cert_path)
        lines.append('  Fingerprint     SHA-256 %s' % app.certificate.fingerprint)
    status = app.album.status()
    if status['status'] != 'empty':
        lines.append('  Album           %s' % status['root'])
    elif app.initial_check is not None and not app.initial_check.ok:
        lines.append('  Album           none: %s is not usable (%s)' % (config.directory, app.initial_check.message))
        lines.append('                  The first browser to connect will be asked for a directory.')
    else:
        lines.append('  Album           none yet: the first browser to connect chooses a directory')
    lines += ['', 'Press Ctrl+C to stop.', '']
    print('\n'.join(lines), flush=True)
