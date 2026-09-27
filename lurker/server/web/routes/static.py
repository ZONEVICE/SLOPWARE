"""The single-page application's files. Registered last: it catches everything."""


def register(router, services):
    files = services.static

    def index(request):
        return files.response(request, 'index.html')

    def asset(request, path):
        return files.response(request, path)

    def icon(request):
        return files.response(request, 'icon.svg')

    router.get('/icon.svg', icon, public=True)
    router.get('/favicon.ico', icon, public=True)
    router.get('/', index)
    router.get('/{path:path}', asset, fallback=True)
