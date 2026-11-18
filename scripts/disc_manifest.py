#!/usr/bin/env python3
"""Describe ISO file extents for a future file-aware disc reader.

The manifest preserves physical offsets because PS2 software may read sectors
that do not belong to a named file. It contains no game file contents.
"""
import argparse
import hashlib
import json
import os

from disc import Image, SECTOR


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('output')
    args = parser.parse_args()
    image = Image(args.image)
    with open(args.image, 'rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    files = []
    for path, layer, sector, size in image.files():
        offset = sector * SECTOR
        if offset + size > image.size:
            raise ValueError('file extends beyond image: ' + path)
        image.file.seek(offset)
        file_hash = hashlib.sha256()
        remaining = size
        while remaining:
            block = image.file.read(min(1 << 20, remaining))
            if not block:
                raise OSError('short image read: ' + path)
            file_hash.update(block)
            remaining -= len(block)
        files.append({'path': path, 'layer': layer.index, 'offset': offset,
                      'size': size, 'sha256': file_hash.hexdigest()})
    files.sort(key=lambda entry: (entry['offset'], entry['path']))
    manifest = {'version': 1, 'image_size': image.size, 'image_sha256': digest,
                'sector_size': SECTOR, 'files': files}
    directory = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(directory, exist_ok=True)
    tmp = args.output + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.replace(tmp, args.output)
    image.file.close()
    print('%d files, %d bytes, SHA-256 %s' % (len(files), image.size, digest))


if __name__ == '__main__':
    main()
