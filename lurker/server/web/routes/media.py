"""The album's files: originals (inline or as a download), previews, details.

URLs name an item by album ID + item ID, never by path, so a client can only
reach files the scan registered. The version segment changes when the file
does, which lets browsers cache media for a day without ever showing a stale
copy; the trailing file name is only there for "Save as" and new tabs.
"""
from ...domain.catalog import display_name
from ..files import serve_file
from ..respond import STREAMED, Response


def register(router, services):
    album = services.album

    def original(request, album_id, item_id, version, name):
        item, path = album.resolve(album_id, item_id)
        download = request.arg('download') == '1'
        serve_file(request.handler, request, path, item.fmt.mime, display_name(item.name),
                   disposition='attachment' if download else 'inline')
        return STREAMED

    def thumb(request, album_id, item_id, version):
        item, path = album.resolve(album_id, item_id)
        data = services.previews.get(item, path)
        return Response(200, data, 'image/jpeg', [('Cache-Control', 'private, max-age=86400')])

    def details(request, album_id, item_id):
        return Response.json(album.details(album_id, item_id))

    router.get('/media/{album_id}/{item_id:int}/{version}/{name:path}', original)
    router.get('/thumb/{album_id}/{item_id:int}/{version}', thumb)
    router.get('/api/items/{album_id}/{item_id:int}', details)

