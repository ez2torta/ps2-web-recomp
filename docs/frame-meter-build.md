# KOF XI (PS2) on the web, with the frame meter

How to build the page from a Mad Gear patched ISO of **The King of Fighters XI**
(Japan, `SLPS-25660`), serve it, and test it from another device over Tailscale.

The whole thing is driven by the [`Makefile`](../Makefile) at the repository root.
Run `make help` for the short list.

---

## 1. What you get

* `build/web-<GAME>/ps2web.html` — a self contained page that boots the game, with
  sound, a memory card in the browser, and save states.
* `web/frame-meter.js` — the experimental Street Fighter 6 style **frame meter**,
  off unless the page URL has `?framemeter=1`. It reads the per frame capture ring
  the runtime fills (`runtime/include/ps2/framemeter.hpp`) and draws two timelines
  (startup / active / recovery / stun) with a `Startup / Total / Advantage` header.
  The "can act" signal is the game's own (`+0x490`, `+0x494`, `+0x530`, `+0x48C`,
  pose `+0x27E`); see [`docs/research/runtime/frame-meter-engine-model-2026-11-25.md`](https://github.com/ez2torta/kofxi_aw_modding/blob/frame-meter/docs/research/runtime/frame-meter-engine-model-2026-11-25.md)
  in the KOF XI research repo.

---

## 2. Prerequisites

Already present in this checkout:

| Need | Where |
|---|---|
| Emscripten SDK | `tools/emsdk` (installed by `scripts/setup.sh`) |
| C++ translation tools | `build/tools/eerecomp`, `build/tools/vurecomp` |
| The game ISO | `games/<GAME>/disc.iso` |
| The translated C++ | `generated/<GAME>/` (produced once by `scripts/port.sh`) |

`make check` verifies all of the above for the current `GAME` and tells you what
is missing.

---

## 3. Build and serve (the everyday loop)

```sh
cd ps2-web-recomp

make check                 # are tools + inputs present?
make build                 # compile the page  -> build/web-<GAME>/
make serve                 # serve on http://127.0.0.1:8620/   (Ctrl-C to stop)
```

Open the printed URL and add `?framemeter=1`:

```
http://127.0.0.1:8620/?framemeter=1
```

`make serve` runs `scripts/serve.py`, which is an HTTP server with byte-range
requests (the page streams the disc image) and the `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` headers the threaded WebAssembly build needs.

Useful variables: `GAME=…`, `PORT=…`, `HOST=…`, `JOBS=…` (see `make help`).

### Testing from another device (Tailscale) — HTTPS is required

A plain `http://<tailscale-ip>:8620` is **not a secure context**, so the browser
refuses the shared memory the engine uses for threads, and the page will not run.
Use **Tailscale Serve**, which serves HTTPS with a trusted certificate for your
tailnet name:

```sh
make tailscale             # shows the https URL and the enable command
# if it is not mapped yet:
tailscale serve --bg --https=443 http://127.0.0.1:8620
make serve                 # keep this running
```

Then, from any device in your tailnet, open:

```
https://<machine>.<tailnet>.ts.net/?framemeter=1
```

The page needs **WebGPU** and a recent Chrome/Edge; a desktop usually has it, a
phone may not yet. If the game does not start, check the browser console — a
"WebGPU not available" message means the device, not the build.

---

## 4. The frame meter controls

Open the page with `?framemeter=1` (any other value, or no parameter, leaves it
off). Parameters:

| URL parameter | Effect |
|---|---|
| `?framemeter=1` | enable the meter strip above the game |
| `&fm_full=1` | the recorder also downloads the whole 0x600 byte player struct per frame |
| `&fm_model=legacy` (or `&fm_neutral=N`) | use the old `actionID <= N` guess instead of the engine signals, for comparison |
| `&fm_act=0xEC` | override the action-id offset |
| `&fm_learn=1` | list the struct bytes that change rarely, to keep finding fields |

Keys (while the page has focus):

| Key | Action |
|---|---|
| **F8** | show/hide the meter strip (the game resizes) |
| **F9** | start / stop a recording |
| **F7** | drop a numbered marker (M1, M2, …) on the next frame |
| **F10** | download the recording (`fm-rec-<time>.csv`, plus `-full.json` with `&fm_full=1`) |

The CSV has one row per game frame with, for each player: character, `actionID`
(`+0xEC`), previous action id (`+0xEE`), `hitboxesActive` (`+0x39E`), the engine
words `+0x490` / `+0x494` / `+0x530` / `+0x48C`, pose (`+0x27E`), `busy` / `react`
/ `hit stop`, HP, guard, stun gauge, `stunTimer` (`+0x582`), status words, facing,
position, the held pad word and the cell the meter assigned. Record up to 7200
frames (2 minutes) per take.

---

## 5. Updating the Mad Gear ISO (official release PPF)

The patched ISO is built from the **official release PPF**, checked against the
checksums published with it. `make iso`:

1. downloads `KOFXI-MadGear-Edition-<version>.ppf` from the
   [KOFXI-Mad-Gear-Edition releases](https://github.com/ATG213/KOFXI-Mad-Gear-Edition/releases),
2. verifies it (the applier checks the source ISO's MD5 and size, and the result
   MD5, and removes the output on any mismatch),
3. writes `../work-madgear/madgear-<version>.iso`.

```sh
make iso                                    # v1.6.1 by default
make iso MADGEAR_VERSION=v1.6.2             # a later release
```

The checksums are variables (`JP_MD5`, `JP_SIZE`, `MG_MD5`) and the source disc is
`JP_ISO`; override them if a release changes them. The application is done by
`kofxi_aw_modding/scripts/ps2-research/madgear_patcher/apply_ppf.py` (a small,
documented PPF 3.0 applier).

### Important: a new ISO means re-running the translation

The engine **translates the game executable to C++**. A newer Mad Gear changes
the executable, so the page must be rebuilt from the new ELF, not just re-pointed
at a new ISO:

```sh
scripts/port.sh kofxi-madgear-v161 "$(pwd)/../work-madgear/madgear-v1.6.1.iso"
# … then:
make build GAME=kofxi-madgear-v161
make serve GAME=kofxi-madgear-v161
```

`scripts/port.sh` reads `SYSTEM.CNF`, extracts the executable, translates it,
optionally runs it headless to find code the static pass missed (adding those
entry points and translating again), and builds the page. `--no-explore` skips the
runtime exploration if you already have a good `entries.txt`.

---

## 6. Reproducing from a fresh clone

```sh
git clone <this repo> ps2-web-recomp && cd ps2-web-recomp
scripts/setup.sh                       # installs the Emscripten SDK in tools/emsdk and the tools in build/tools
mkdir -p games/kofxi-madgear-v161
ln -s /path/to/madgear-v1.6.1.iso games/kofxi-madgear-v161/disc.iso
scripts/port.sh kofxi-madgear-v161 games/kofxi-madgear-v161/disc.iso
make build GAME=kofxi-madgear-v161
make serve GAME=kofxi-madgear-v161
```

---

## 7. Tests

The frame meter and its page glue are pure JavaScript and are tested without a
browser:

```sh
make test        # node tests/frame_meter_test.js + node tests/frame_meter_page_test.js
```

`frame_meter_test.js` reproduces the Street Fighter 6 reference screenshot
(Startup 4F / Total 13F / +5F) and the whiff, block, multi-hit, hit-stop,
crouch-guard-release and wakeup cases.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page loads, game does not start | not a secure context: use the HTTPS Tailscale URL, or `http://127.0.0.1` on this machine |
| "WebGPU not available" | the device/browser lacks WebGPU; try a desktop Chrome/Edge |
| Meter strip absent | the URL lacks `?framemeter=1` |
| `make build` rebuilds everything | expected after a new ISO: `generated/<GAME>/` changed |
| `make check` says generated missing | run `scripts/port.sh <GAME> "<iso>"` once |
