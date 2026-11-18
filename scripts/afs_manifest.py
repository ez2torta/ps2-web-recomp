#!/usr/bin/env python3
"""Index an AFS archive while preserving entry offsets for sector reads."""
import argparse
import hashlib
import json
import os
import struct


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('output')
    parser.add_argument('--entries-dir', help='extract entries by numeric index')
    args = parser.parse_args()
    size = os.path.getsize(args.archive)
    entries = []
    with open(args.archive, 'rb') as source:
        header = source.read(8)
        if len(header) != 8 or header[:4] != b'AFS\0':
            raise ValueError('not an AFS archive')
        count = struct.unpack_from('<I', header, 4)[0]
        if count > 100000 or 8 + count * 8 > size:
            raise ValueError('invalid AFS directory size')
        table = source.read(count * 8)
        for index in range(count):
            offset, length = struct.unpack_from('<II', table, index * 8)
            if offset > size or length > size - offset:
                raise ValueError('entry outside archive: %d' % index)
            source.seek(offset)
            prefix = source.read(min(8, length)).hex()
            source.seek(offset)
            entry_hash = hashlib.sha256()
            remaining = length
            if args.entries_dir:
                os.makedirs(args.entries_dir, exist_ok=True)
                destination = os.path.join(args.entries_dir, '%04d.bin' % index)
                output = open(destination + '.tmp', 'wb')
            else:
                output = None
            try:
                while remaining:
                    block = source.read(min(1 << 20, remaining))
                    if not block:
                        raise OSError('short AFS entry: %d' % index)
                    entry_hash.update(block)
                    if output:
                        output.write(block)
                    remaining -= len(block)
            finally:
                if output:
                    output.close()
            if output:
                os.replace(destination + '.tmp', destination)
            entries.append({'index': index, 'offset': offset, 'size': length,
                            'sha256': entry_hash.hexdigest(), 'prefix_hex': prefix})
        source.seek(0)
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    result = {'version': 1, 'archive_size': size, 'archive_sha256': digest, 'entries': entries}
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    temporary = args.output + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    os.replace(temporary, args.output)
    print('%d entries, %d bytes, SHA-256 %s' % (count, size, digest))


if __name__ == '__main__':
    main()
