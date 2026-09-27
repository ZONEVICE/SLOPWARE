"""The live stream of album changes (text/event-stream)."""
from ..respond import STREAMED


def register(router, services):
    def events(request):
        services.hub.serve(request.handler, request)
        return STREAMED

    router.get('/api/events', events)
