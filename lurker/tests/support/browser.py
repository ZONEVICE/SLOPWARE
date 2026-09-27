"""A minimal headless Chromium driver for the end-to-end tests.

It speaks the Chrome DevTools Protocol over `--remote-debugging-pipe`:
Chromium reads commands from file descriptor 3 and writes answers to file
descriptor 4, as NUL-terminated JSON. No WebSocket and no package is needed,
so the test suite stays standard-library only. A tiny `sh -c 'exec ... 3<&N
4>&M'` puts the pipes on the descriptor numbers Chromium expects.

When no Chromium or Chrome binary exists, `find_browser()` returns None and
the browser tests skip themselves.
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time

CANDIDATES = [
    os.environ.get('LURKER_CHROME'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
]


def find_browser():
    if os.environ.get('LURKER_SKIP_BROWSER_TESTS') == '1' or os.name == 'nt':
        return None
    for candidate in CANDIDATES:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


class BrowserError(RuntimeError):
    pass


class Browser:
    def __init__(self, width=1280, height=900):
        binary = find_browser()
        if not binary:
            raise BrowserError('No Chromium/Chrome binary found')
        self.width = width
        self.height = height
        self.profile = tempfile.mkdtemp(prefix='lurker-chrome-')
        commands_read, self._commands = os.pipe()
        self._answers, answers_write = os.pipe()
        args = [
            '--headless=new', '--remote-debugging-pipe', '--user-data-dir=%s' % self.profile,
            '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-extensions', '--disable-background-networking', '--disable-sync',
            '--ignore-certificate-errors', '--hide-scrollbars', '--mute-audio',
            '--autoplay-policy=no-user-gesture-required', '--window-size=%d,%d' % (width, height),
            'about:blank',
        ]
        script = 'exec "$0" "$@" 3<&%d 4>&%d' % (commands_read, answers_write)
        self.process = subprocess.Popen(
            ['/bin/sh', '-c', script, binary] + args,
            pass_fds=(commands_read, answers_write),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.close(commands_read)
        os.close(answers_write)
        self._next_id = 1
        self._lock = threading.Lock()
        self._pending = {}
        self._listeners = []
        self._closed = False
        self._reader = threading.Thread(target=self._read_loop, name='cdp-reader', daemon=True)
        self._reader.start()
        self.send('Browser.getVersion', timeout=30)

    # --- protocol --------------------------------------------------------------

    def _read_loop(self):
        buffer = b''
        while True:
            try:
                chunk = os.read(self._answers, 65536)
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
            while b'\0' in buffer:
                raw, buffer = buffer.split(b'\0', 1)
                try:
                    message = json.loads(raw.decode('utf-8'))
                except ValueError:
                    continue
                if 'id' in message:
                    with self._lock:
                        waiter = self._pending.pop(message['id'], None)
                    if waiter is not None:
                        waiter['message'] = message
                        waiter['event'].set()
                elif 'method' in message:
                    for listener in list(self._listeners):
                        try:
                            listener(message)
                        except Exception:
                            pass
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for waiter in pending:
            waiter['message'] = {'error': {'message': 'browser closed'}}
            waiter['event'].set()

    def send(self, method, params=None, session=None, timeout=30):
        with self._lock:
            message_id = self._next_id
            self._next_id += 1
            waiter = {'event': threading.Event(), 'message': None}
            self._pending[message_id] = waiter
        message = {'id': message_id, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        os.write(self._commands, json.dumps(message).encode('utf-8') + b'\0')
        if not waiter['event'].wait(timeout):
            with self._lock:
                self._pending.pop(message_id, None)
            raise BrowserError('Timed out waiting for %s' % method)
        answer = waiter['message']
        if 'error' in answer:
            raise BrowserError('%s failed: %s' % (method, answer['error'].get('message')))
        return answer.get('result', {})

    def listen(self, callback):
        self._listeners.append(callback)
        return lambda: self._listeners.remove(callback)

    def wait_event(self, method, session=None, timeout=15, predicate=None):
        found = threading.Event()
        holder = {}

        def listener(message):
            if message.get('method') != method or (session and message.get('sessionId') != session):
                return
            if predicate and not predicate(message.get('params', {})):
                return
            holder['params'] = message.get('params', {})
            found.set()

        remove = self.listen(listener)
        try:
            if not found.wait(timeout):
                raise BrowserError('Timed out waiting for event %s' % method)
            return holder['params']
        finally:
            remove()

    # --- pages -----------------------------------------------------------------------

    def new_page(self, url=None, width=None, height=None, mobile=False, scale=1, timezone='UTC'):
        """A new tab, brought to the front. Dates are shown in `timezone` so tests do not depend on the host's."""
        target = self.send('Target.createTarget', {'url': 'about:blank'})['targetId']
        session = self.send('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        page = Page(self, target, session)
        for domain in ('Page.enable', 'Runtime.enable', 'Log.enable'):
            self.send(domain, session=session)
        self.send('Emulation.setDeviceMetricsOverride', {
            'width': width or self.width, 'height': height or self.height, 'deviceScaleFactor': scale,
            'mobile': mobile}, session=session)
        if mobile:
            self.send('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 5}, session=session)
        if timezone:
            self.send('Emulation.setTimezoneOverride', {'timezoneId': timezone}, session=session)
        if url:
            page.goto(url)
        return page

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self.send('Browser.close', timeout=3)
        except BrowserError:
            pass
        try:
            self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(5)
        for descriptor in (self._commands, self._answers):
            try:
                os.close(descriptor)
            except OSError:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)


class Page:
    def __init__(self, browser, target, session):
        self.browser = browser
        self.target = target
        self.session = session
        self.errors = []
        self.console = []
        browser.listen(self._collect)

    def _collect(self, message):
        if message.get('sessionId') != self.session:
            return
        method = message.get('method')
        params = message.get('params', {})
        if method == 'Runtime.exceptionThrown':
            details = params.get('exceptionDetails', {})
            exception = details.get('exception', {})
            self.errors.append(exception.get('description') or details.get('text'))
        elif method == 'Runtime.consoleAPICalled':
            text = ' '.join(str(arg.get('value', arg.get('description', ''))) for arg in params.get('args', []))
            self.console.append((params.get('type'), text))
            if params.get('type') == 'error':
                self.errors.append(text)
        elif method == 'Log.entryAdded':
            entry = params.get('entry', {})
            if entry.get('level') == 'error':
                self.console.append(('log-error', entry.get('text', '') + ' ' + entry.get('url', '')))

    def send(self, method, params=None, timeout=30):
        return self.browser.send(method, params, session=self.session, timeout=timeout)

    def front(self):
        """Make this the visible tab: background tabs get throttled like in a real browser."""
        self.send('Page.bringToFront')

    def goto(self, url, timeout=20):
        self._load(lambda: self.send('Page.navigate', {'url': url}), url, timeout)

    def reload(self, timeout=20):
        """Reload the page (navigating to the same URL with a #hash would not)."""
        self._load(lambda: self.send('Page.reload', {'ignoreCache': True}), 'reload', timeout)

    def _load(self, start, what, timeout):
        loaded = threading.Event()

        def listener(message):
            if message.get('sessionId') == self.session and message.get('method') == 'Page.loadEventFired':
                loaded.set()

        remove = self.browser.listen(listener)
        try:
            start()
            if not loaded.wait(timeout):
                raise BrowserError('Page did not load: %s' % what)
        finally:
            remove()

    def evaluate(self, expression, timeout=30):
        result = self.send('Runtime.evaluate', {
            'expression': expression, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True,
        }, timeout=timeout)
        if 'exceptionDetails' in result:
            details = result['exceptionDetails']
            raise BrowserError('Page error: %s' % (details.get('exception', {}).get('description') or details.get('text')))
        return result.get('result', {}).get('value')

    def wait_for(self, expression, timeout=15, interval=0.1, message=None):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                last = self.evaluate(expression)
                # An element comes back as {} (truthy in JavaScript, falsy in Python).
                if last not in (None, False, 0, '', []):
                    return last
            except BrowserError as error:
                last = str(error)
            time.sleep(interval)
        raise AssertionError(message or 'Timed out waiting for: %s (last: %r)' % (expression, last))

    def click(self, selector):
        return self.evaluate(
            '(() => { const el = document.querySelector(%s); if (!el) throw new Error("no element " + %s); '
            'el.click(); return true; })()' % (json.dumps(selector), json.dumps(selector)))

    def exists(self, selector):
        return self.evaluate('Boolean(document.querySelector(%s))' % json.dumps(selector))

    def text(self, selector):
        return self.evaluate('(document.querySelector(%s) || {}).textContent || ""' % json.dumps(selector))

    def type(self, selector, value):
        """Focus the element, clear it, and type `value` as real key input."""
        self.evaluate('(() => { const el = document.querySelector(%s); el.focus(); el.select && el.select(); return true; })()'
                      % json.dumps(selector))
        self.send('Input.insertText', {'text': value})

    def key(self, key, code=None, key_code=0, modifiers=0):
        """Press and release a key. Enter and printable keys also produce their text."""
        text = '\r' if key == 'Enter' else key if len(key) == 1 else None
        down = {'type': 'keyDown' if text else 'rawKeyDown', 'key': key, 'code': code or key,
                'windowsVirtualKeyCode': key_code, 'modifiers': modifiers}
        if text:
            down['text'] = text
        self.send('Input.dispatchKeyEvent', down)
        self.send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': key, 'code': code or key,
                                             'windowsVirtualKeyCode': key_code, 'modifiers': modifiers})

    def mouse(self, kind, x, y, button='left', clicks=1, delta_y=0):
        params = {'type': kind, 'x': x, 'y': y, 'button': button, 'clickCount': clicks}
        if kind == 'mouseWheel':
            params = {'type': kind, 'x': x, 'y': y, 'deltaX': 0, 'deltaY': delta_y}
        self.send('Input.dispatchMouseEvent', params)

    def screenshot(self, path):
        data = self.send('Page.captureScreenshot', {'format': 'png'})['data']
        with open(path, 'wb') as handle:
            handle.write(base64.b64decode(data))
        return path

    def close(self):
        try:
            self.browser.send('Target.closeTarget', {'targetId': self.target})
        except BrowserError:
            pass
