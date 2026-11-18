#!/usr/bin/env python3
"""Read an AFS from verified individual entries and its original metadata."""
import bisect
import hashlib
import json
import os


class FileAFS:
    def __init__(self, archive_path, manifest_path, entries_root):
        with open(manifest_path, encoding='utf-8') as stream:
            manifest = json.load(stream)
        self.archive = open(archive_path, 'rb')
        if os.fstat(self.archive.fileno()).st_size != manifest['archive_size']:
            raise ValueError('archive size differs from manifest')
        if hashlib.file_digest(self.archive, 'sha256').hexdigest() != manifest['archive_sha256']:
            raise ValueError('archive hash differs from manifest')
        self.size = manifest['archive_size']
        self.entries = sorted((e for e in manifest['entries'] if e['size']), key=lambda e: e['offset'])
        self.starts = [e['offset'] for e in self.entries]
        if any(a['offset'] + a['size'] > b['offset'] for a, b in zip(self.entries, self.entries[1:])):
            raise ValueError('overlapping AFS entries')
        self.root = entries_root
        self.verified = {}

    def close(self):
        self.archive.close()

    def _entry_file(self, entry):
        path = os.path.join(self.root, '%04d.bin' % entry['index'])
        try:
            stat = os.stat(path)
            if stat.st_size != entry['size']:
                return None
            signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if self.verified.get(path) != signature:
                with open(path, 'rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                        return None
                self.verified[path] = signature
            return path
        except OSError:
            return None

    def read(self, offset, size):
        if offset < 0 or size < 0 or offset + size > self.size:
            raise ValueError('read outside archive')
        result = bytearray()
        end = offset + size
        while offset < end:
            index = bisect.bisect_right(self.starts, offset) - 1
            entry = self.entries[index] if index >= 0 else None
            if entry and offset < entry['offset'] + entry['size']:
                stop = min(end, entry['offset'] + entry['size'])
                path = self._entry_file(entry)
                if path:
                    with open(path, 'rb') as source:
                        source.seek(offset - entry['offset'])
                        data = source.read(stop - offset)
                else:
                    self.archive.seek(offset)
                    data = self.archive.read(stop - offset)
            else:
                next_index = index + 1
                stop = min(end, self.starts[next_index] if next_index < len(self.starts) else end)
                self.archive.seek(offset)
                data = self.archive.read(stop - offset)
            if len(data) != stop - offset:
                raise OSError('short AFS read')
            result.extend(data)
            offset = stop
        return bytes(result)
