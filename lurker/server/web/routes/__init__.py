"""Every HTTP endpoint, one module per feature.

A module exposes `register(router, services)` and adds its routes. To add an
endpoint, create a module here and add its `register` to ROUTE_PLUGINS; to
remove a feature, delete its line. Order matters only for `static`, whose
catch-all route must stay last.

`services` (see server/app.py) carries: config, bus, identity, album, auth,
previews, hub and static.
"""
from . import album, auth, events, media, paths, state, static

ROUTE_PLUGINS = [
    auth.register,      # /login, /api/auth/logout
    state.register,     # /api/state
    events.register,    # /api/events (server-sent events)
    paths.register,     # /api/paths/*: validate and complete directory paths
    album.register,     # /api/album/*: open, close, rescan, delta
    media.register,     # /media/*, /thumb/*, /api/items/*
    static.register,    # /, /icon.svg, /css/*, /js/* (catch-all: keep last)
]
