"""Everything a freshly loaded page needs to draw itself."""
from ...domain import paths
from ...media import formats
from ..respond import Response


def register(router, services):
    def state(request):
        return Response.json({
            'app': services.identity.as_dict(),
            'album': services.album.status(),
            'formats': formats.public_table(),
            'shortcuts': paths.shortcuts(),
        })

    router.get('/api/state', state)
