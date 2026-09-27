"""HTTP: the only layer that knows about requests, headers, cookies and sockets.

Routes translate a request into a call on a domain service and the result
into a response. They hold no rules of their own. See routes/__init__.py for
where to add an endpoint.
"""
