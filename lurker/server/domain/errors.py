class AppError(Exception):
    """A failure the user should see: a machine `code`, a sentence, an HTTP status."""

    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def as_dict(self):
        body = {'code': self.code, 'message': self.message}
        body.update(self.extra)
        return {'error': body}
