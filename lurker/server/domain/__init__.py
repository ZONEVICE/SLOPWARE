"""Lurker's rules: the album, its catalog, scanning, probing and passwords.

Nothing in this package knows about HTTP. Services raise AppError (with an
HTTP status the web layer copies) and announce changes on the event bus.
"""
