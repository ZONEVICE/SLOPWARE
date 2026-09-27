"""What Lurker knows about media files: formats, and how to read their headers.

Nothing here decodes pixels. The readers only walk container structures (JPEG
segments, PNG chunks, MP4 boxes, Matroska elements...) to find dimensions,
durations, dates, orientation and embedded previews, reading as few bytes as
possible. Pixels are the browser's job.
"""
