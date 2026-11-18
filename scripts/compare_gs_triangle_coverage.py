#!/usr/bin/env python3
"""Compare captured GS triangle coverage by edge and scanline formulations.

This is a geometric cross-check, not a PCSX2 implementation or a comparison of
interpolated attributes, texture fetches, depth tests, or final pixels.
"""
import argparse
import csv
import math
from collections import OrderedDict
from pathlib import Path


def scissor_rect(value):
    bits = int(value, 16)
    return (bits & 0x7FF, (bits >> 16) & 0x7FF,
            (bits >> 32) & 0x7FF, (bits >> 48) & 0x7FF)


def vertices_for_batch(rows):
    first = rows[0]
    offset = int(first['xyoffset'], 16)
    ofx, ofy = offset & 0xFFFF, (offset >> 32) & 0xFFFF
    points = [((int(row['x']) - ofx) / 16.0,
               (int(row['y']) - ofy) / 16.0) for row in rows]
    return points, scissor_rect(first['scissor'])


def area(points):
    (x0, y0), (x1, y1), (x2, y2) = points
    return (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)


def edge_coverage(points, rect):
    if area(points) == 0:
        return set()
    (x0, y0), (x1, y1), (x2, y2) = points
    sign = 1.0 if area(points) > 0 else -1.0
    sx0, sx1, sy0, sy1 = rect
    left = max(sx0, math.ceil(min(x0, x1, x2)))
    right = min(sx1, math.ceil(max(x0, x1, x2)) - 1)
    top = max(sy0, math.ceil(min(y0, y1, y2)))
    bottom = min(sy1, math.ceil(max(y0, y1, y2)) - 1)
    covered = set()

    def edge_in(value, gx, gy):
        return value > 0 or (value == 0 and (gx > 0 or (gx == 0 and gy > 0)))

    for y in range(top, bottom + 1):
        for x in range(left, right + 1):
            e0 = (x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)
            e1 = (x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)
            e2 = (x0 - x) * (y1 - y) - (x1 - x) * (y0 - y)
            if (edge_in(e0 * sign, (y1 - y2) * sign, (x2 - x1) * sign) and
                    edge_in(e1 * sign, (y2 - y0) * sign, (x0 - x2) * sign) and
                    edge_in(e2 * sign, (y0 - y1) * sign, (x1 - x0) * sign)):
                covered.add((x, y))
    return covered


def scanline_coverage(points, rect):
    if area(points) == 0:
        return set()
    sx0, sx1, sy0, sy1 = rect
    ymin = max(sy0, math.ceil(min(y for _, y in points)))
    ymax = min(sy1, math.ceil(max(y for _, y in points)) - 1)
    edges = [(points[i], points[(i + 1) % 3]) for i in range(3)]
    covered = set()
    for y in range(ymin, ymax + 1):
        intersections = []
        for (xa, ya), (xb, yb) in edges:
            if ya == yb or not min(ya, yb) <= y < max(ya, yb):
                continue
            intersections.append(xa + (y - ya) * (xb - xa) / (yb - ya))
        if len(intersections) < 2:
            continue
        left = max(sx0, math.ceil(min(intersections)))
        right = min(sx1, math.ceil(max(intersections)) - 1)
        covered.update((x, y) for x in range(left, right + 1))
    return covered


def compare(path):
    groups = OrderedDict()
    with path.open(newline='', encoding='utf-8') as source:
        for row in csv.DictReader(source, delimiter='\t'):
            key = (row['batch'], row['primitive'], row['frame'])
            groups.setdefault(key, []).append(row)

    triangles = visible = edge_pixels = scanline_pixels = differing = xor_pixels = 0
    examples = []
    for key, rows in groups.items():
        if len(rows) != 3:
            continue
        points, rect = vertices_for_batch(rows)
        triangles += 1
        edge = edge_coverage(points, rect)
        scanline = scanline_coverage(points, rect)
        visible += bool(edge)
        edge_pixels += len(edge)
        scanline_pixels += len(scanline)
        if edge != scanline:
            differing += 1
            xor_pixels += len(edge ^ scanline)
            if len(examples) < 5:
                examples.append((key, len(edge), len(scanline), len(edge ^ scanline)))

    print(f'{path}: triangles={triangles} visible={visible} '
          f'edge_pixels={edge_pixels} scanline_pixels={scanline_pixels} '
          f'different_triangles={differing} xor_pixels={xor_pixels}')
    for example in examples:
        print('  mismatch batch/primitive/frame=%s edge=%d scanline=%d xor=%d' % example)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('vertices_tsv', nargs='+', type=Path)
    args = parser.parse_args()
    for path in args.vertices_tsv:
        compare(path)


if __name__ == '__main__':
    main()
