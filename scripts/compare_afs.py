#!/usr/bin/env python3
"""Produce a bounded-memory comparison of AFS entries and ADX headers."""
import argparse
import csv
import hashlib
import os
import struct


def inspect(path):
    stream = open(path, 'rb')
    size = os.fstat(stream.fileno()).st_size
    head = stream.read(8)
    if len(head) != 8 or head[:4] != b'AFS\0':
        raise ValueError('not AFS: ' + path)
    count = struct.unpack_from('<I', head, 4)[0]
    if count > 100000 or 16 + count * 8 > size:
        raise ValueError('invalid table')
    table = stream.read(count * 8)
    meta_offset, meta_size = struct.unpack('<II', stream.read(8))
    names = [''] * count
    if meta_offset and meta_size >= count * 48 and meta_offset + meta_size <= size:
        stream.seek(meta_offset)
        metadata = stream.read(count * 48)
        names = [metadata[i * 48:i * 48 + 32].split(b'\0', 1)[0].decode('ascii', 'replace') for i in range(count)]
    rows = []
    for index in range(count):
        offset, length = struct.unpack_from('<II', table, index * 8)
        if offset + length > size:
            raise ValueError('entry exceeds archive')
        stream.seek(offset)
        head = stream.read(min(length, 16))
        stream.seek(offset)
        sha = hashlib.sha256()
        remain = length
        while remain:
            block = stream.read(min(remain, 1 << 20))
            if not block:
                raise OSError('short AFS read')
            sha.update(block)
            remain -= len(block)
        adx = len(head) >= 16 and head[:2] == b'\x80\0'
        rows.append({'name': names[index], 'offset': offset, 'size': length, 'sha256': sha.hexdigest(),
                     'rate': struct.unpack_from('>I', head, 8)[0] if adx else '',
                     'channels': head[7] if adx else '',
                     'samples': struct.unpack_from('>I', head, 12)[0] if adx else ''})
    stream.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original')
    parser.add_argument('modified')
    parser.add_argument('output')
    args = parser.parse_args()
    left = inspect(args.original)
    right = inspect(args.modified)
    if len(left) != len(right):
        raise ValueError('entry count differs')
    fields = ['index', 'name', 'original_bytes', 'modified_bytes', 'original_rate', 'modified_rate',
              'original_channels', 'modified_channels', 'original_samples', 'modified_samples', 'identical']
    with open(args.output, 'w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for i, (a, b) in enumerate(zip(left, right)):
            writer.writerow({'index': i, 'name': a['name'], 'original_bytes': a['size'],
                             'modified_bytes': b['size'], 'original_rate': a['rate'], 'modified_rate': b['rate'],
                             'original_channels': a['channels'], 'modified_channels': b['channels'],
                             'original_samples': a['samples'], 'modified_samples': b['samples'],
                             'identical': a['sha256'] == b['sha256']})
    print('compared', len(left), 'entries')


if __name__ == '__main__':
    main()
