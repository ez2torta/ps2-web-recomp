# Experimental file-aware disc reader

The original ISO remains required. This optional reader maps ISO byte ranges to verified files extracted from that same image and uses the ISO for directory records, gaps, large files, missing assets and any failed or invalid asset. It does not alter the default reader. It is not yet validated for all games or browser storage implementations.

## Prepare locally

Do not commit or publish the image, extracted files, manifests containing game-derived names, or generated web output. Given a game already built with `port.sh`, create a manifest and extract its image with the existing `disc.py` tooling:

```sh
python3 scripts/disc_manifest.py games/mygame/disc.iso games/mygame/disc-manifest.json
python3 scripts/disc.py extract games/mygame/disc.iso games/mygame/disc-files --limit 0
python3 scripts/prepare_file_disc.py games/mygame/disc-manifest.json games/mygame/disc-files build/web-mygame
```

`prepare_file_disc.py` checks size and SHA-256 of each included asset, uses a hard link when available and otherwise copies it, and writes `file-disc-manifest.json` plus `assets/<sha256>` in the build. Hard links share the underlying file: do not modify extracted inputs in place. The browser validates the complete file again before using it. Assets over 8 MiB are currently left on ISO to avoid downloading giant files for a small read.

For an AFS archive, use `scripts/afs_manifest.py` with `--entries-dir` to index and extract entries, then add `--archive-path`, `--archive-manifest` and `--archive-entries` to `prepare_file_disc.py`. The archive hash and size must match the file in the disc manifest. The AFS table, padding and large entries continue to come from the ISO. This initial implementation handles one optional archive.

Start the server with an explicit manifest:

```sh
PS2_FILE_DISC_MANIFEST=build/web-mygame/file-disc-manifest.json \
  python3 scripts/serve.py build/web-mygame games/mygame/disc.iso --game games/mygame
```

The server hashes the image at startup and exposes its identity only when it matches the manifest. Open the normal URL with `?filedisc=1`. Cross-origin isolation and a secure context are required; the Web Crypto API is used to check hashes. If the manifest, identity, asset, checksum or browser cache is unavailable, the affected reads fall back to the ISO. Browser storage is bounded to 16 full assets of at most 8 MiB and 512 chunks of at most 256 KiB (up to 256 MiB total), with a 16 MiB in-memory cache. The browser may evict stored data or decline storage. The first load of a file can transfer more than an equivalent ISO range and may be slower; compare real first and repeated loads before enabling it for regular play.

For inspection, `window.ps2FileDisc.stats` reports network requests and bytes separately for files and ISO, cache hits, memory hits and fallbacks. When `PS2_LOG_DISC_READS=1`, the local server additionally accepts periodic aggregate metrics; it does not record file names or asset contents. A file-disc build is specific to its ISO hash; regenerate the manifest when the image changes.

For a game with a verified filler file, `--zero-file PATH` (repeatable) preserves its ISO extent and synthesizes zeros instead of reading it. This deliberately changes the image bytes and must be validated for the specific game and paths; it is disabled by default. The 8 MiB limit applies to normal assets, not to zero-filled extents. At most four file downloads run concurrently.

`--stream-adx` splits ADX archive entries into disc-aligned pieces of at most 256 KiB, so the first part can be supplied without downloading the entire music file. `--zero-padding-image` checks the SHA-256 of the original ISO and includes only sector padding verified to contain zeros. For a traced startup group, `--bundle-prefix PREFIX --preload-bundles` groups matching small files in bundles of up to 4 MiB and records them as preload candidates. Preloading is still opt-in with `?filedisc=1&filedisc_preload=1`; it trades extra time and data before Start for fewer requests later. Keep it off unless measurements justify the tradeoff.

The experimental IndexedDB cache format is upgraded when streaming is first enabled. This clears the earlier **file cache only**; cards and save states live in separate databases. Close older experimental tabs if the upgrade is blocked; without cache access, reads still use the network or ISO fallback.
