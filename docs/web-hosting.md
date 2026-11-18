# Hosting the web build

The browser build is a set of static files: `ps2web.html`, JavaScript, WebAssembly, and game data. A single-player session does not need Node.js, a database, or a game backend. The browser still must load the files over HTTPS (or a secure local origin); opening the page with `file://` does not provide the secure, cross-origin-isolated context required by `SharedArrayBuffer`.

“Static build” describes the files and the game runtime, not a requirement to avoid HTTP. Any static host is suitable if it can set the response headers below and serve byte ranges for the disc image. The project’s `scripts/serve.py` is a small file server with optional room signaling; the file server behavior is used for single player and local two player, while only **Invite** needs the signaling endpoint. A CDN or static host can replace it for solo/local play when configured with the required headers, range support, and file-disc identity header. Tailscale Serve can expose the private file server without making the game data public.

## Requirements for the file-disc build

The file-disc reader is enabled with `?filedisc=1`. The optional module preload is enabled with `&filedisc_preload=1`. The page reads its `file-disc-manifest.json` and content-addressed `assets/` files alongside the HTML, and uses the ISO as a fallback for ranges not covered by those files.

The server must:

- Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page and its resources.
- Support byte-range requests to the ISO and return the correct content length.
- For file-disc mode, return `X-Disc-Sha256` and `Content-Length` on `HEAD` for the ISO, matching the manifest.
- Serve the manifest and its `assets/` files from the same build directory.

The existing `scripts/serve.py` supplies these headers and behaviors. It is an HTTP file server with a small optional room-signaling endpoint. Local two-player and single-player play do not use room signaling; **Invite** does.

## Existing KOF XI build

The Japan file-disc preload build is generated at `build/web-kofxi-filedisc-preload`. The ISO and build contain game data and should remain private. To serve this variant at `/filedisc/`, set both `PS2_FILE_DISC_BUILD` and `PS2_FILE_DISC_MANIFEST` in the local service definition to that build and its manifest, then restart `kofxi-web.service`. The private deployment in this working checkout now uses the preload build; request startup preloading with `?filedisc=1&filedisc_preload=1`.

For a phone, use an HTTPS address reachable from that device, such as the private Tailscale Serve URL, followed by `/filedisc/?filedisc=1&filedisc_preload=1`. The service must stay running on the host. Plain HTTP to a LAN IP is not considered a secure browser context on most phones. The browser must support cross-origin isolation, WebAssembly JSPI (`WebAssembly.Suspending`), and WebGPU. Phone compatibility has not yet been verified; check the page's startup capability message before diagnosing game behavior.

Safari 27.0 added JSPI support, and WebKit lists Safari 27.0 as available on iOS. This removes the known JSPI version gap for up-to-date iPhones, but does not establish that this game runs correctly or at a usable speed on a particular phone. WebGPU, cross-origin isolation, memory limits, and performance still need a device test. The page’s capability check is the source of truth for a given browser.

Do not publish the ISO or the game-containing build to a public host. For a general static host to serve this experimental mode, configure the headers and ISO range support above, and expose only a private URL.
