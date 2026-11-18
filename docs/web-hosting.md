# Hosting the web build

The browser build is a set of static files: `ps2web.html`, JavaScript, WebAssembly, and game data. A single-player session does not need Node.js, a database, or a game backend. The browser still must load the files over HTTPS (or a secure local origin); opening the page with `file://` does not provide the secure, cross-origin-isolated context required by `SharedArrayBuffer`.

## Requirements for the file-disc build

The file-disc reader is enabled with `?filedisc=1`. The optional module preload is enabled with `&filedisc_preload=1`. The page reads its `file-disc-manifest.json` and content-addressed `assets/` files alongside the HTML, and uses the ISO as a fallback for ranges not covered by those files.

The server must:

- Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page and its resources.
- Support byte-range requests to the ISO and return the correct content length.
- For file-disc mode, return `X-Disc-Sha256` and `Content-Length` on `HEAD` for the ISO, matching the manifest.
- Serve the manifest and its `assets/` files from the same build directory.

The existing `scripts/serve.py` supplies these headers and behaviors. It is an HTTP file server with a small optional room-signaling endpoint. Local two-player and single-player play do not use room signaling; **Invite** does.

## Existing KOF XI build

The Japan file-disc preload build is generated at `build/web-kofxi-filedisc-preload`. The ISO and build contain game data and should remain private. The service definition under the local `deploy/` directory currently serves `build/web-kofxi-filedisc` at `/filedisc/`; it does not serve the `-preload` build unless its `PS2_FILE_DISC_BUILD` and `PS2_FILE_DISC_MANIFEST` settings are changed together.

For a phone, use an HTTPS address reachable from that device, such as the private Tailscale Serve URL. Plain HTTP to a LAN IP is not considered a secure browser context on most phones. The browser must support cross-origin isolation, WebAssembly JSPI (`WebAssembly.Suspending`), and WebGPU. Phone compatibility has not yet been verified; check the page's startup capability message before diagnosing game behavior.

Do not publish the ISO or the game-containing build to a public host. For a general static host to serve this experimental mode, configure the headers and ISO range support above, and expose only a private URL.
