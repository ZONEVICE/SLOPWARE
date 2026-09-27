"""The password page: the only page served before a browser unlocks Lurker.

It is rendered on the server and works without JavaScript, because with a
password set nothing else (not even the application's scripts) is served
before the password is accepted. Its styles are inline, allowed by a
per-response CSP nonce.
"""
import html
import os
import re
import secrets

from .. import PUBLIC_DIR
from .respond import Response

_ICON = None


def _icon():
    global _ICON
    if _ICON is None:
        try:
            with open(os.path.join(PUBLIC_DIR, 'icon.svg'), encoding='utf-8') as handle:
                _ICON = re.sub(r'<svg ', '<svg class="logo" aria-hidden="true" ', handle.read(), count=1)
        except OSError:
            _ICON = ''
    return _ICON


_STYLE = """
:root{color-scheme:dark light;--bg:#0d0b16;--card:#17132a;--line:#2c2548;--text:#ece8ff;--muted:#a49dc4;
--accent:#f6a93b;--accent-text:#1b1204;--danger:#ff8a80;--field:#0f0c1d}
@media (prefers-color-scheme:light){:root{--bg:#f4f2fb;--card:#fff;--line:#dcd6ef;--text:#1c1730;--muted:#5d5678;
--accent:#c86d14;--accent-text:#fff;--danger:#b3261e;--field:#faf9ff}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;
padding:32px 28px 28px;box-shadow:0 20px 60px rgb(0 0 0 / 25%);text-align:center}
.logo{width:76px;height:76px;display:block;margin:0 auto 14px}
h1{margin:0;font-size:1.45rem;letter-spacing:.01em}
p{margin:6px 0 22px;color:var(--muted);font-size:.95rem}
form{display:grid;gap:12px;text-align:left}
label{font-size:.85rem;color:var(--muted)}
input{width:100%;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:12px;
padding:12px 14px;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px 16px;background:var(--accent);
color:var(--accent-text);cursor:pointer}
button:hover{filter:brightness(1.07)}
.error{margin:0;color:var(--danger);font-size:.9rem}
"""


def render(error=None, status=200, next_path='/'):
    nonce = secrets.token_urlsafe(16)
    message = '<p class="error" role="alert">%s</p>' % html.escape(error) if error else ''
    page = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Lurker · Locked</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style nonce="%(nonce)s">%(style)s</style>
</head>
<body>
<main>
%(icon)s
<h1>Lurker is locked</h1>
<p>Enter the password to see the album.</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="%(next)s">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
%(message)s
<button type="submit">Unlock</button>
</form>
</main>
</body>
</html>
""" % {'nonce': nonce, 'style': _STYLE, 'icon': _icon(), 'message': message, 'next': html.escape(next_path)}
    csp = ("default-src 'none'; img-src 'self'; style-src 'nonce-%s'; form-action 'self'; base-uri 'none'; "
           "frame-ancestors 'none'" % nonce)
    return Response.html(page, status, [('Content-Security-Policy', csp), ('Cache-Control', 'no-store')])
