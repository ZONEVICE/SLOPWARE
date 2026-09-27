"""Helping the user type a directory: live validation and completion."""
from ...domain import paths
from ..respond import Response


def register(router, services):
    def check(request):
        return Response.json(paths.check_directory(str(request.json().get('path', ''))).as_dict())

    def suggest(request):
        return Response.json({'suggestions': paths.suggest(request.arg('path', ''))})

    router.post('/api/paths/check', check)
    router.get('/api/paths/suggest', suggest)
