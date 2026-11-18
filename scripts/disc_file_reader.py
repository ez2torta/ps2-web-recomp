#!/usr/bin/env python3
"""Prototype sector-preserving reads from extracted files and an ISO fallback.

Files are used only when their content has been verified against the image.
This local prototype does not alter the running web service.
"""
import bisect
import hashlib
import json
import os


class FileDisc:
    def __init__(self, image_path, manifest_path, files_root, zero_files=()):
        with open(manifest_path, encoding='utf-8') as stream:
            manifest = json.load(stream)
        self.image = open(image_path, 'rb')
        if os.fstat(self.image.fileno()).st_size != manifest['image_size']:
            raise ValueError('image size differs from manifest')
        if hashlib.file_digest(self.image, 'sha256').hexdigest() != manifest['image_sha256']:
            raise ValueError('image hash differs from manifest')
        self.size = manifest['image_size']
        self.entries = manifest['files']
        self.starts = [entry['offset'] for entry in self.entries]
        self.root = os.path.realpath(files_root)
        self.zero_files = frozenset(zero_files)
        self.verified = {}
        for a, b in zip(self.entries, self.entries[1:]):
            if a['offset'] + a['size'] > b['offset']:
                raise ValueError('overlapping file extents')

    def close(self):
        self.image.close()

    def _local(self, entry):
        path = os.path.realpath(os.path.join(self.root, entry['path']))
        if os.path.commonpath((self.root, path)) != self.root or not os.path.isfile(path):
            return None
        stat = os.stat(path)
        if stat.st_size != entry['size']:
            return None
        signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if self.verified.get(path) == signature:
            return path
        expected = hashlib.sha256()
        actual = hashlib.sha256()
        self.image.seek(entry['offset'])
        remaining = entry['size']
        with open(path, 'rb') as stream:
            while remaining:
                amount = min(1 << 20, remaining)
                source = self.image.read(amount)
                local = stream.read(amount)
                if len(source) != amount or len(local) != amount:
                    return None
                expected.update(source)
                actual.update(local)
                remaining -= amount
        if actual.digest() != expected.digest():
            return None
        self.verified[path] = signature
        return path

    def read(self, offset, size):
        if offset < 0 or size < 0 or offset + size > self.size:
            raise ValueError('read outside image')
        result = bytearray()
        end = offset + size
        while offset < end:
            index = bisect.bisect_right(self.starts, offset) - 1
            entry = self.entries[index] if index >= 0 else None
            if entry and offset < entry['offset'] + entry['size']:
                stop = min(end, entry['offset'] + entry['size'])
                path = None if entry['path'] in self.zero_files else self._local(entry)
                if entry['path'] in self.zero_files:
                    data = bytes(stop - offset)
                elif path:
                    with open(path, 'rb') as stream:
                        stream.seek(offset - entry['offset'])
                        data = stream.read(stop - offset)
                else:
                    self.image.seek(offset)
                    data = self.image.read(stop - offset)
            else:
                next_index = index + 1
                stop = min(end, self.starts[next_index] if next_index < len(self.starts) else end)
                self.image.seek(offset)
                data = self.image.read(stop - offset)
            if len(data) != stop - offset:
                raise OSError('short disc read')
            result.extend(data)
            offset = stop
        return bytes(result)
