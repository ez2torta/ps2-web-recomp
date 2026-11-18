#!/usr/bin/env python3
"""Serves a web build and a disc image with HTTP range requests.

usage: serve.py <build dir> <disc image> [port] [--host address] [--game <games/name>] [--record <dir for unrecorded VU1 programs>]

With --game the page's findings are kept for the next port.sh run: VU1 programs
the build lacks go to <games/name>/vu1 and entry points its interpreter met to
<games/name>/entries.txt.

It also relays the messages that connect a host page to the guests it invites
(/room), so a friend can play along from another browser.
"""

import http.server
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
import urllib.parse

RECORD = None
if '--record' in sys.argv:
    at = sys.argv.index('--record')
    RECORD = os.path.abspath(sys.argv[at + 1])
    del sys.argv[at:at + 2]
ENTRIES = None
if '--game' in sys.argv:
    at = sys.argv.index('--game')
    game = os.path.abspath(sys.argv[at + 1])
    del sys.argv[at:at + 2]
    RECORD = RECORD or os.path.join(game, 'vu1')
    ENTRIES = os.path.join(game, 'entries.txt')
ENTRY_LOCK = threading.Lock()
HOST = '127.0.0.1'
if '--host' in sys.argv:
    at = sys.argv.index('--host')
    HOST = sys.argv[at + 1]
    del sys.argv[at:at + 2]
BUILD = os.path.abspath(sys.argv[1])
DISC = os.path.abspath(sys.argv[2])
DISC_IDENTITY = None
DISC_STAT = None
if os.environ.get('PS2_FILE_DISC_MANIFEST'):
    with open(os.environ['PS2_FILE_DISC_MANIFEST'], encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    with open(DISC, 'rb') as disc_file:
        DISC_STAT = os.fstat(disc_file.fileno())
        DISC_IDENTITY = hashlib.file_digest(disc_file, 'sha256').hexdigest()
    if manifest.get('image_size') != DISC_STAT.st_size or manifest.get('image_sha256') != DISC_IDENTITY:
        raise SystemExit('file-disc manifest does not match disc image')
ALT_BUILD = os.path.abspath(os.environ['PS2_ALT_BUILD']) if os.environ.get('PS2_ALT_BUILD') else None
ALT_DISC = os.path.abspath(os.environ['PS2_ALT_DISC']) if os.environ.get('PS2_ALT_DISC') else None
FILE_BUILD = os.path.abspath(os.environ['PS2_FILE_DISC_BUILD']) if os.environ.get('PS2_FILE_DISC_BUILD') else None
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8620
ROOMS = {}
ROOMS_CHANGED = threading.Condition()
ROOM_PATH = re.compile(r'^/room(?:/([A-Z2-9]{6})/([a-z0-9]{1,16}))?$')
ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
ROOM_IDLE = 3600
TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream'}


class Handler(http.server.BaseHTTPRequestHandler):
    def target(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/filedisc/') and FILE_BUILD and DISC_IDENTITY:
            name = path[len('/filedisc/'):]
            if name == 'disc.iso':
                return DISC
            if not name:
                name = 'ps2web.html'
            full = os.path.realpath(os.path.join(FILE_BUILD, name))
            root = os.path.realpath(FILE_BUILD)
            return full if os.path.commonpath((root, full)) == root and os.path.isfile(full) else None
        if path.startswith('/china/') and ALT_BUILD and ALT_DISC:
            name = path[len('/china/'):]
            if name == 'disc.iso':
                return ALT_DISC
            if not name:
                name = 'ps2web.html'
            full = os.path.realpath(os.path.join(ALT_BUILD, name))
            root = os.path.realpath(ALT_BUILD)
            return full if os.path.commonpath((root, full)) == root and os.path.isfile(full) else None
        if path in ('/', '/index.html'):
            path = '/ps2web.html'
        if path == '/disc.iso':
            return DISC
        if path.endswith('/'):
            path += 'index.html'
        name = os.path.normpath(path.lstrip('/'))
        if name.startswith('..') or name == '.':
            return None
        full = os.path.join(BUILD, name)
        return full if os.path.isfile(full) else None

    def headers_for(self, path, length, encoding=None):
        self.send_header('Content-Type', TYPES.get(os.path.splitext(path)[1], 'application/octet-stream'))
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-cache')
        if path == DISC and DISC_IDENTITY:
            stat = os.stat(DISC)
            if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) == (DISC_STAT.st_dev, DISC_STAT.st_ino, DISC_STAT.st_size, DISC_STAT.st_mtime_ns):
                self.send_header('X-Disc-Sha256', DISC_IDENTITY)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers()

    def send_json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def room_get(self, code, me):
        match = re.search(r'after=(\d+)', self.path)
        after = int(match.group(1)) if match else 0
        deadline = time.time() + 20
        with ROOMS_CHANGED:
            while True:
                room = ROOMS.get(code)
                if room is None:
                    self.send_json({'error': 'no such room'}, 404)
                    return
                room['seen'] = time.time()
                inbox = room['inboxes'].setdefault(me, [])
                left = deadline - time.time()
                if len(inbox) > after or left <= 0:
                    messages = inbox[after:]
                    break
                ROOMS_CHANGED.wait(left)
        self.send_json({'messages': messages, 'next': after + len(messages)})

    def do_POST(self):
        if self.path == '/__file_disc_metrics' and os.environ.get('PS2_LOG_DISC_READS') == '1':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > 2048:
                    raise ValueError('invalid length')
                data = json.loads(self.rfile.read(length))
                fields = ('assetRequests', 'assetBytes', 'cacheHits', 'memoryHits', 'isoRequests', 'isoBytes', 'zeroBytes', 'fallbacks')
                values = [data[key] for key in fields]
                if any(type(value) is not int or not 0 <= value < 10**12 for value in values):
                    raise ValueError('invalid metric')
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            print('[file-disc-client] files=%d file_bytes=%d cache_hits=%d memory_hits=%d iso=%d iso_bytes=%d zero_bytes=%d fallbacks=%d' % tuple(values), flush=True)
            self.send_json({'ok': True})
            return
        if self.path == '/__disc_metrics' and os.environ.get('PS2_LOG_DISC_READS') == '1':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > 2048:
                    raise ValueError('invalid length')
                data = json.loads(self.rfile.read(length))
                fields = ('count', 'bytes', 'ms', 'maxMs', 'failed', 'windowMs')
                values = [data[key] for key in fields]
                if any(type(value) not in (int, float) or not 0 <= value < 1e12 for value in values):
                    raise ValueError('invalid metric')
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            print('[disc-client] requests=%d bytes=%d total_ms=%.1f max_ms=%.1f failed=%d window_ms=%.1f' % tuple(values), flush=True)
            self.send_json({'ok': True})
            return
        match = ROOM_PATH.match(self.path.split('?', 1)[0])
        length = int(self.headers.get('Content-Length', '0'))
        if not match or length > 65536:
            self.send_error(404 if not match else 413)
            return
        body = self.rfile.read(length)
        code, to = match.groups()
        with ROOMS_CHANGED:
            now = time.time()
            for old in [c for c, r in ROOMS.items() if now - r['seen'] > ROOM_IDLE]:
                del ROOMS[old]
            if not code:
                code = ''.join(secrets.choice(ROOM_LETTERS) for _ in range(6))
                while code in ROOMS:
                    code = ''.join(secrets.choice(ROOM_LETTERS) for _ in range(6))
                ROOMS[code] = {'inboxes': {}, 'seen': now}
                result = {'room': code}
            elif code in ROOMS:
                try:
                    message = json.loads(body)
                except ValueError:
                    message = None
                if not isinstance(message, dict):
                    self.send_json({'error': 'bad message'}, 400)
                    return
                ROOMS[code]['inboxes'].setdefault(to, []).append(message)
                ROOMS[code]['seen'] = now
                ROOMS_CHANGED.notify_all()
                result = {}
            else:
                self.send_json({'error': 'no such room'}, 404)
                return
        self.send_json(result)

    def do_HEAD(self):
        path = self.target()
        if not path:
            self.send_error(404)
            return
        self.send_response(200)
        self.headers_for(path, os.path.getsize(path))

    def do_GET(self):
        match = ROOM_PATH.match(self.path.split('?', 1)[0])
        if match and match.group(1):
            self.room_get(*match.groups())
            return
        path = self.target()
        if not path:
            self.send_error(404)
            return
        packed = path + '.gz'
        if ('Range' not in self.headers and 'gzip' in self.headers.get('Accept-Encoding', '') and os.path.isfile(packed)
                and os.path.getmtime(packed) >= os.path.getmtime(path)):
            self.send_response(200)
            self.headers_for(path, os.path.getsize(packed), 'gzip')
            with open(packed, 'rb') as f:
                shutil.copyfileobj(f, self.wfile, 1 << 20)
            return
        size = os.path.getsize(path)
        match = re.match(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        start, end = 0, size - 1
        if match:
            start = int(match.group(1))
            end = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(200)
        self.headers_for(path, end - start + 1)
        left = end - start + 1
        began = time.monotonic()
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                while left > 0:
                    chunk = f.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        finally:
            if path in (DISC, ALT_DISC) and os.environ.get('PS2_LOG_DISC_READS') == '1':
                print('[disc-read] range=%d-%d bytes=%d duration_ms=%.1f complete=%s' %
                      (start, end, end - start + 1 - left,
                       (time.monotonic() - began) * 1000, left == 0), flush=True)

    def do_PUT(self):
        path = urllib.parse.unquote(self.path.split('?', 1)[0])
        entry = re.match(r'^/entry/((?:[A-Za-z0-9_.-]{1,64}:)?[0-9a-f]{1,8})$', path)
        if entry:
            if not ENTRIES:
                self.send_error(501)
                return
            with ENTRY_LOCK:
                known = set(open(ENTRIES).read().split()) if os.path.exists(ENTRIES) else set()
                if entry.group(1) not in known:
                    with open(ENTRIES, 'a') as f:
                        f.write(entry.group(1) + '\n')
                    print('recorded entry point', entry.group(1), flush=True)
            self.send_response(201)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        match = re.match(r'^/vu1/([0-9A-F]{16}_[0-9A-F]{4}\.bin)$', path)
        length = int(self.headers.get('Content-Length', '0'))
        if not RECORD or not match or length != 16384:
            self.send_error(501 if not RECORD else 400)
            return
        data = self.rfile.read(length)
        target = os.path.join(RECORD, match.group(1))
        if not os.path.exists(target):
            os.makedirs(RECORD, exist_ok=True)
            with open(target, 'wb') as f:
                f.write(data)
            print('recorded', match.group(1), flush=True)
        self.send_response(201)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


print('serving %s and %s on http://%s:%d/' % (BUILD, DISC, HOST, PORT))
http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
