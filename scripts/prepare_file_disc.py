#!/usr/bin/env python3
"""Prepare a content-addressed experimental disc bundle from local files.

All game-derived output is written to the supplied local output directory.
The ISO is still required for metadata, gaps and files outside the size limit.
"""
import argparse
import hashlib
import json
import os
import shutil

MAX_FILE = 8 * 1024 * 1024
DISC_CHUNK = 256 * 1024
SECTOR = 2048
BUNDLE_LIMIT = 4 * 1024 * 1024


def checked_source(root, relative, size, expected):
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, relative))
    if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
        raise ValueError('missing or invalid source: ' + relative)
    with open(path, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size != size or hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
            raise ValueError('source does not match manifest: ' + relative)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('disc_manifest')
    parser.add_argument('files_dir')
    parser.add_argument('output_dir')
    parser.add_argument('--archive-path')
    parser.add_argument('--archive-manifest')
    parser.add_argument('--archive-entries')
    parser.add_argument('--stream-adx', action='store_true',
                        help='split ADX entries into disc-aligned chunks')
    parser.add_argument('--zero-padding-image',
                        help='verify image identity and synthesize only sector padding verified as zero')
    parser.add_argument('--bundle-prefix', action='append', default=[],
                        help='bundle matching small files (repeatable)')
    parser.add_argument('--preload-bundles', action='store_true',
                        help='mark bundles as candidates for optional startup preload')
    parser.add_argument('--zero-file', action='append', default=[],
                        help='explicitly synthesize a known filler file as zero bytes (repeatable)')
    args = parser.parse_args()
    if any((args.archive_path, args.archive_manifest, args.archive_entries)) and not all((args.archive_path, args.archive_manifest, args.archive_entries)):
        parser.error('all archive options are required together')
    if args.stream_adx and not args.archive_manifest:
        parser.error('--stream-adx requires archive options')
    if args.preload_bundles and not args.bundle_prefix:
        parser.error('--preload-bundles requires --bundle-prefix')
    with open(args.disc_manifest, encoding='utf-8') as stream:
        disc = json.load(stream)
    if disc.get('version') != 1:
        raise ValueError('unsupported disc manifest')
    archive = None
    if args.archive_manifest:
        with open(args.archive_manifest, encoding='utf-8') as stream:
            archive = json.load(stream)
    assets = os.path.join(args.output_dir, 'assets')
    os.makedirs(assets, exist_ok=True)
    extents = []
    zero_files = set(args.zero_file)
    zero_seen = set()
    archive_seen = False
    bundle = bytearray()
    bundle_members = []
    preloads = []

    def add(offset, size, sha, source_root, relative):
        if not isinstance(offset, int) or not isinstance(size, int) or offset < 0 or size <= 0 or size > MAX_FILE or offset + size > disc['image_size']:
            raise ValueError('invalid asset extent')
        if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('invalid asset digest')
        source = checked_source(source_root, relative, size, sha)
        destination = os.path.join(assets, sha)
        if os.path.exists(destination):
            checked_source(assets, sha, size, sha)
        else:
            try:
                os.link(source, destination)
            except OSError:
                temporary = destination + '.tmp'
                shutil.copyfile(source, temporary)
                os.replace(temporary, destination)
        extents.append({'offset': offset, 'size': size, 'sha256': sha, 'url': 'assets/' + sha})

    def add_adx_chunks(base, item):
        relative = '%04d.bin' % item['index']
        source = checked_source(args.archive_entries, relative, item['size'], item['sha256'])
        position = base + item['offset']
        remaining = item['size']
        with open(source, 'rb') as stream:
            while remaining:
                size = min(remaining, DISC_CHUNK - position % DISC_CHUNK)
                data = stream.read(size)
                if len(data) != size:
                    raise OSError('short archive entry: ' + relative)
                sha = hashlib.sha256(data).hexdigest()
                destination = os.path.join(assets, sha)
                if os.path.exists(destination):
                    checked_source(assets, sha, size, sha)
                else:
                    temporary = destination + '.tmp'
                    with open(temporary, 'wb') as out:
                        out.write(data)
                    os.replace(temporary, destination)
                extents.append({'offset': position, 'size': size, 'sha256': sha, 'url': 'assets/' + sha})
                position += size
                remaining -= size

    def flush_bundle():
        if not bundle_members:
            return
        sha = hashlib.sha256(bundle).hexdigest()
        destination = os.path.join(assets, sha)
        if os.path.exists(destination):
            checked_source(assets, sha, len(bundle), sha)
        else:
            temporary = destination + '.tmp'
            with open(temporary, 'wb') as out:
                out.write(bundle)
            os.replace(temporary, destination)
        for offset, size, asset_offset in bundle_members:
            extents.append({'offset': offset, 'size': size, 'sha256': sha,
                            'url': 'assets/' + sha, 'asset_offset': asset_offset,
                            'asset_size': len(bundle)})
        if args.preload_bundles:
            preloads.append(sha)
        bundle.clear()
        bundle_members.clear()

    def bundle_file(entry):
        if len(bundle) + entry['size'] > BUNDLE_LIMIT:
            flush_bundle()
        source = checked_source(args.files_dir, entry['path'], entry['size'], entry['sha256'])
        with open(source, 'rb') as stream:
            data = stream.read(entry['size'] + 1)
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('bundle source changed: ' + entry['path'])
        bundle_members.append((entry['offset'], entry['size'], len(bundle)))
        bundle.extend(data)

    for entry in disc['files']:
        if entry['path'] in zero_files:
            if entry['path'] == args.archive_path or entry['size'] <= 0:
                raise ValueError('invalid filler file: ' + entry['path'])
            zero_seen.add(entry['path'])
            extents.append({'offset': entry['offset'], 'size': entry['size'], 'zero': True})
        elif entry['path'] == args.archive_path:
            if archive_seen:
                raise ValueError('duplicate archive path in disc manifest')
            archive_seen = True
            if not archive or archive.get('version') != 1 or archive.get('archive_sha256') != entry['sha256'] or archive.get('archive_size') != entry['size']:
                raise ValueError('archive manifest does not match disc')
            for item in archive['entries']:
                if not isinstance(item['index'], int) or item['index'] < 0 or item['offset'] < 0 or item['size'] < 0 or item['offset'] + item['size'] > entry['size']:
                    raise ValueError('invalid archive extent')
                if args.stream_adx and item.get('prefix_hex', '').startswith('8000') and item['size']:
                    add_adx_chunks(entry['offset'], item)
                elif 0 < item['size'] <= MAX_FILE:
                    add(entry['offset'] + item['offset'], item['size'], item['sha256'], args.archive_entries, '%04d.bin' % item['index'])
        elif 0 < entry['size'] <= BUNDLE_LIMIT and any(entry['path'].startswith(prefix) for prefix in args.bundle_prefix):
            bundle_file(entry)
        elif 0 < entry['size'] <= MAX_FILE:
            add(entry['offset'], entry['size'], entry['sha256'], args.files_dir, entry['path'])
    flush_bundle()
    if zero_seen != zero_files:
        raise ValueError('filler file absent from disc manifest: ' + ', '.join(sorted(zero_files - zero_seen)))
    if args.archive_path and not archive_seen:
        raise ValueError('archive file absent from disc manifest: ' + args.archive_path)
    extents.sort(key=lambda e: e['offset'])
    if any(a['offset'] + a['size'] > b['offset'] for a, b in zip(extents, extents[1:])):
        raise ValueError('overlapping file extents')
    if args.zero_padding_image:
        with open(args.zero_padding_image, 'rb') as image:
            if os.fstat(image.fileno()).st_size != disc['image_size'] or hashlib.file_digest(image, 'sha256').hexdigest() != disc['image_sha256']:
                raise ValueError('padding image does not match disc manifest')
            padding = []
            for index, entry in enumerate(extents):
                end = entry['offset'] + entry['size']
                next_offset = extents[index + 1]['offset'] if index + 1 < len(extents) else disc['image_size']
                length = min((-end) % SECTOR, next_offset - end)
                if length:
                    image.seek(end)
                    data = image.read(length)
                    if len(data) != length:
                        raise OSError('short image padding read')
                    if not any(data):
                        padding.append({'offset': end, 'size': length, 'zero': True})
            extents.extend(padding)
            extents.sort(key=lambda e: e['offset'])
    manifest = {'version': 1, 'image_sha256': disc['image_sha256'], 'image_size': disc['image_size'], 'extents': extents, 'preload': preloads}
    path = os.path.join(args.output_dir, 'file-disc-manifest.json')
    with open(path + '.tmp', 'w', encoding='utf-8') as stream:
        json.dump(manifest, stream, separators=(',', ':'))
        stream.write('\n')
    os.replace(path + '.tmp', path)
    print('%d extents; %d file bytes, %d synthesized zero bytes' %
          (len(extents), sum(e['size'] for e in extents if not e.get('zero')),
           sum(e['size'] for e in extents if e.get('zero'))))


if __name__ == '__main__':
    main()
