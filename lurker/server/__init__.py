"""Lurker's server: standard-library Python only.

Layers, from the bottom up (a module never imports from a layer above it):

    config  ->  lib  ->  media  ->  domain  ->  web  ->  app  ->  main

See CLAUDE.md for what each layer owns.
"""
import os

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(APP_DIR, 'public')


def read_version():
    """The version string from version.txt, or '0.0.0' if it is missing."""
    try:
        with open(os.path.join(APP_DIR, 'version.txt'), encoding='utf-8') as handle:
            return handle.read().strip() or '0.0.0'
    except OSError:
        return '0.0.0'
