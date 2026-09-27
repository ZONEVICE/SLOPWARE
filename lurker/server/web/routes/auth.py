"""Unlocking and locking: the login form and logout."""
from ...domain.errors import AppError
from .. import loginpage
from ..guard import safe_next
from ..respond import Response


def register(router, services):
    auth = services.auth

    def cookie(token, clear=False):
        parts = ['%s=%s' % (auth.cookie_name, '' if clear else token), 'Path=/', 'HttpOnly', 'SameSite=Strict']
        if services.identity.protocol == 'https':
            parts.append('Secure')
        if clear:
            parts.append('Max-Age=0')
        # No Max-Age otherwise: a session cookie, gone when the browser closes.
        return '; '.join(parts)

    def show(request):
        if not auth.enabled or auth.check(request.cookies.get(auth.cookie_name), request.client_ip,
                                          request.user_agent):
            return Response.redirect(safe_next(request.arg('next')))
        return loginpage.render(next_path=safe_next(request.arg('next')))

    def submit(request):
        if not auth.enabled:
            return Response.redirect('/')
        form = request.form()
        target = safe_next(form.get('next'))
        try:
            token = auth.login(form.get('password', ''), request.client_ip, request.user_agent)
        except AppError as error:
            response = loginpage.render(error=error.message, status=error.status, next_path=target)
            if error.status == 429:
                response.headers.append(('Retry-After', str(error.extra.get('retryAfter', 1))))
            return response
        return Response(303, b'', None, [('Location', target), ('Set-Cookie', cookie(token)),
                                         ('Cache-Control', 'no-store')])

    def logout(request):
        if request.session_token:
            auth.logout(request.session_token)
        return Response.json({'ok': True}, headers=[('Set-Cookie', cookie('', clear=True))])

    router.get('/login', show, public=True)
    router.post('/login', submit, public=True)
    router.post('/api/auth/logout', logout)
