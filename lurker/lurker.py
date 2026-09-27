#!/usr/bin/env python3
"""Lurker: every image and video under one directory, in one browser grid.

Only the Python standard library is needed:

    python3 lurker.py                         # HTTPS on port 8080, or the next free one
    python3 lurker.py http port 9000          # plain HTTP, starting at port 9000
    python3 lurker.py dir /srv/photos pass s3cret

Run `python3 lurker.py help` to see every option.
"""
import sys

if sys.version_info < (3, 8):
    sys.exit('Lurker needs Python 3.8 or newer.')

from server.main import main  # noqa: E402  (the version check must run first)

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
