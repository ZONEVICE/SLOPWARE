#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Start Frisbee with only the Python 2.7 or Python 3 standard library."""
from __future__ import print_function, unicode_literals

import argparse
import os
import signal
import socket
import sys

from frisbee_core.server import create_available_server
from frisbee_core.compat import fs_text


def main():
    parser = argparse.ArgumentParser(description='Share files and notes over HTTP.')
    parser.add_argument('--host', default='0.0.0.0', help='Bind address (default: all IPv4 interfaces).')
    parser.add_argument('--port', type=int, default=8080,
                        help='Starting HTTP port; try higher ports if occupied (default: 8080; 0: OS chooses).')
    parser.add_argument('--data-dir', default=os.path.dirname(os.path.abspath(fs_text(__file__))),
                        help='Directory containing workspace/ and notepad/ (default: application directory).')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('The port must be between 0 and 65535.')
    try:
        server = create_available_server(args.host, args.port, args.data_dir)
    except (socket.error, OSError, IOError, ValueError) as error:
        parser.exit(1, 'Cannot start Frisbee: %s\n' % error)

    def stop(signum, frame):
        raise KeyboardInterrupt()

    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, stop)
    port = server.server_address[1]
    if args.port and port != args.port:
        print('Requested port %s is in use; using port %s.' % (args.port, port))
    print('Frisbee is ready: http://localhost:%s/' % port)
    if args.host == '0.0.0.0':
        try:
            addresses = sorted(set(socket.gethostbyname_ex(socket.gethostname())[2]))
            for address in addresses:
                if not address.startswith('127.'):
                    print('Network address: http://%s:%s/' % (address, port))
        except socket.error:
            pass
        print('Other devices: open http://<this-host-LAN-IP>:%s/' % port)
    print('No accounts or passwords. Press Ctrl+C to stop.')
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print('\nStopping Frisbee; waiting for active moves to finish...')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
