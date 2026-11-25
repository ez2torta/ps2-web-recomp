# =============================================================================
#  KOF XI (PS2)  ->  web build with the frame meter
#  Reproducible Makefile for the `ps2-web-recomp` engine.
# =============================================================================
#
#  WHAT THIS DOES
#  --------------
#  Turns a Mad Gear patched ISO of The King of Fighters XI (Japan, SLPS-25660)
#  into a self contained web page in build/web-<GAME>/ and serves it. The page
#  boots the game, and with ?framemeter=1 it draws the experimental Street
#  Fighter 6 style frame meter on top (web/frame-meter.js).
#
#  The web build follows the engine's normal pipeline: the game executable is
#  translated to C++ (recompiled) and compiled to WebAssembly. So changing the
#  ISO (a new Mad Gear version) means re-running the translation, not just
#  swapping a file.
#
#  QUICK START
#  -----------
#      make check                 # verify the tools and inputs are present
#      make iso                   # (optional) build the official Mad Gear ISO from the release PPF
#      make build                 # translate + compile the page  -> build/web-<GAME>/
#      make serve                 # serve it on http://127.0.0.1:8620/
#      make test                  # run the frame meter unit tests (node, no browser)
#
#  Then open the page. Add ?framemeter=1 to turn the frame meter on:
#      http://127.0.0.1:8620/?framemeter=1
#
#  TO TEST FROM ANOTHER DEVICE (Tailscale)
#  ---------------------------------------
#  A plain http://<tailscale-ip>:8620 is NOT a secure context, so the browser
#  blocks the shared memory the threaded engine needs. Use Tailscale Serve,
#  which terminates HTTPS with a trusted certificate for your tailnet name:
#
#      make tailscale            # prints the https URL mapped to PORT, and how to enable it
#      make serve                # keep this running
#      # open https://<machine>.<tailnet>.ts.net/?framemeter=1 from any tailnet device
#
#  `tailscale serve` maps https://<machine>.<tailnet>.ts.net/ to 127.0.0.1:8620
#  (this machine already has that mapping). The page needs WebGPU and a recent
#  Chrome/Edge; a phone may not have WebGPU yet, a desktop usually does.
#
#  OVERRIDABLE VARIABLES (all optional)
#  ------------------------------------
#      GAME=kofxi-madgear-full     which games/<GAME>/ to build/serve
#      PORT=8620                   HTTP port to serve on
#      HOST=127.0.0.1              address serve.py binds (Tailscale Serve uses 127.0.0.1)
#      JOBS=8                      parallel compile jobs
#      EMSDK=.../tools/emsdk       Emscripten SDK location
#      JP_ISO="...iso"             original Japanese disc, for `make iso`
#      MADGEAR_VERSION=v1.6.1      Mad Gear release to fetch, for `make iso`
#
# =============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ---- configurable -----------------------------------------------------------
GAME            ?= kofxi-madgear-v161
PORT            ?= 8620
HOST            ?= 127.0.0.1
JOBS            ?= $(shell nproc 2>/dev/null || echo 4)
EMSDK           ?= $(CURDIR)/tools/emsdk
PYTHON          ?= python3
NODE            ?= node

# ---- Mad Gear ISO inputs (only used by `make iso`) --------------------------
MADGEAR_VERSION ?= v1.6.1
MADGEAR_TAG     ?= ps2-$(MADGEAR_VERSION)
# Official release, published by ATG (github.com/ATG213/KOFXI-Mad-Gear-Edition).
PPF_URL         ?= https://github.com/ATG213/KOFXI-Mad-Gear-Edition/releases/download/$(MADGEAR_TAG)/KOFXI-MadGear-Edition-$(MADGEAR_VERSION).ppf
# Expected checksums published with the release (verified by `make iso`).
JP_ISO          ?= /home/tortita/Coding/Github/Side/ps2_kofxi/King of Fighters XI, The (Japan).iso
JP_MD5          ?= 2bb2d183e85964a799f3eb73b5812a71
JP_SIZE         ?= 2540208128
MG_MD5          ?= 672fe267db6d022e2203167eaaaa55c1
# Where the downloaded PPF and the patched ISO are written.
DL_DIR          ?= $(CURDIR)/../work-madgear/downloads
WORK_DIR        ?= $(CURDIR)/../work-madgear
PPF             := $(DL_DIR)/KOFXI-MadGear-Edition-$(MADGEAR_VERSION).ppf
MG_ISO          := $(WORK_DIR)/madgear-$(MADGEAR_VERSION).iso
# The repo that holds the PPF applier (documented, checked, versioned).
PPF_APPLIER     ?= $(CURDIR)/../kofxi_aw_modding/scripts/ps2-research/madgear_patcher/apply_ppf.py

# ---- derived paths ----------------------------------------------------------
GAME_DIR   := $(CURDIR)/games/$(GAME)
DISC       := $(GAME_DIR)/disc.iso
GENERATED  := $(CURDIR)/generated/$(GAME)
WEB_DIR    := $(CURDIR)/build/web-$(GAME)
SERVE      := scripts/serve.py
BUILD_WEB  := scripts/build_web.sh
TS_DNS     := $(shell tailscale status --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null)

.PHONY: help check iso build serve test tailscale clean tidy dist

# -----------------------------------------------------------------------------
help: ## Show this help.
	@echo 'KOF XI (PS2) web build with the frame meter'
	@echo
	@echo 'Targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo 'Current settings:  GAME=$(GAME)  PORT=$(PORT)  HOST=$(HOST)  JOBS=$(JOBS)'
	@echo '                   WEB_DIR=$(WEB_DIR)'

check: ## Verify tools and inputs for the current GAME.
	@fail=0; \
	  [ -f "$(EMSDK)/emsdk_env.sh" ] || { echo "missing emsdk at $(EMSDK) (run scripts/setup.sh)"; fail=1; }; \
	  command -v ninja >/dev/null   || { echo "missing ninja"; fail=1; }; \
	  command -v cmake >/dev/null   || { echo "missing cmake"; fail=1; }; \
	  command -v $(NODE) >/dev/null || { echo "missing node (frame meter tests)"; fail=1; }; \
	  [ -e "$(DISC)" ]              || { echo "missing $(DISC) (put the ISO there, or 'make iso' + link it)"; fail=1; }; \
	  [ -d "$(GENERATED)" ]         || { echo "missing $(GENERATED) (run 'make build' the first time, or scripts/port.sh $(GAME) <iso>)"; fail=1; }; \
	  [ "$$fail" = 0 ] && echo "ok: tools and inputs for '$(GAME)' are present"; \
	  exit $$fail

# -----------------------------------------------------------------------------
# ISO: fetch the official Mad Gear release PPF and apply it to the Japanese disc.
# -----------------------------------------------------------------------------
iso: $(MG_ISO) ## Download the official Mad Gear PPF and build the patched ISO (checked).

$(MG_ISO):
	@echo "== fetching $(MADGEAR_VERSION) release PPF"
	@mkdir -p "$(DL_DIR)"
	@if [ ! -f "$(PPF)" ]; then curl -fL --retry 3 -o "$(PPF)" "$(PPF_URL)"; else echo "PPF already present: $(PPF)"; fi
	@echo "== applying to $(JP_ISO)"
	@$(PYTHON) "$(PPF_APPLIER)" "$(PPF)" "$(JP_ISO)" "$(MG_ISO)" \
	    --md5-in "$(JP_MD5)" --md5-out "$(MG_MD5)" --size "$(JP_SIZE)"

# -----------------------------------------------------------------------------
# BUILD: translate the game executable to C++ (first time) and compile the page.
# `scripts/build_web.sh` sources the Emscripten environment, configures CMake,
# runs ninja and gzips the artifacts. It needs generated/<GAME>/ to exist; the
# first time, create it with:  scripts/port.sh $(GAME) "$(DISC)"
# -----------------------------------------------------------------------------
build: check ## Build build/web-<GAME>/ (translate is done by scripts/port.sh the first time).
	@echo "== building web page for '$(GAME)'"
	@PS2_BUILD_JOBS=$(JOBS) $(BUILD_WEB) $(GAME) "$(EMSDK)"
	@echo "== done: $(WEB_DIR)/ps2web.html"

# -----------------------------------------------------------------------------
# SERVE: run the range-request server the page expects. Tailscale Serve (if you
# use it) proxies https://<machine>.<tailnet>.ts.net/ to 127.0.0.1:$(PORT).
# -----------------------------------------------------------------------------
serve: check ## Serve the build on HOST:PORT (foreground; Ctrl-C to stop).
	@echo "serving $(WEB_DIR) on http://$(HOST):$(PORT)/"
	@echo "frame meter:  http://$(HOST):$(PORT)/?framemeter=1"
	@[ -n "$(TS_DNS)" ] && echo "tailscale:    https://$(TS_DNS)/?framemeter=1" || true
	@exec $(PYTHON) $(SERVE) "$(WEB_DIR)" "$(DISC)" $(PORT) --host $(HOST) --game "$(GAME_DIR)"

# -----------------------------------------------------------------------------
# TEST: the frame meter is pure JavaScript, so its tests need no browser.
# -----------------------------------------------------------------------------
test: ## Run the frame meter unit tests (node).
	@$(NODE) tests/frame_meter_test.js
	@$(NODE) tests/frame_meter_page_test.js

# -----------------------------------------------------------------------------
# TAILSCALE: HTTPS for the tailnet, which the browser needs for shared memory.
# -----------------------------------------------------------------------------
tailscale: ## Show the Tailscale Serve URL for PORT and how to (un)configure it.
	@echo "Tailscale DNS name : $(TS_DNS)"
	@if [ -n "$(TS_DNS)" ]; then echo "URL                : https://$(TS_DNS)/?framemeter=1"; fi
	@echo
	@echo "Current Tailscale Serve mappings:"
	@tailscale serve status 2>/dev/null || echo "  (tailscale serve not configured or not permitted)"
	@echo
	@echo "To map https://$(TS_DNS)/  ->  http://127.0.0.1:$(PORT):"
	@echo "    tailscale serve --bg --https=443 http://127.0.0.1:$(PORT)"
	@echo "To remove every serve mapping:"
	@echo "    tailscale serve reset"

# -----------------------------------------------------------------------------
# HOUSEKEEPING
# -----------------------------------------------------------------------------
clean: ## Remove the CMake build dir for the current GAME.
	rm -rf "$(WEB_DIR)"
	@echo "removed $(WEB_DIR)"

tidy: ## Also remove the translated C++ for the current GAME (keeps the ISO).
	rm -rf "$(WEB_DIR)" "$(GENERATED)" "$(GAME_DIR)/disc" "$(GAME_DIR)/shots"
	@echo "removed build + generated output for $(GAME)"

dist: build ## Pack the build dir into a tarball for sharing.
	tar -C "$(CURDIR)/build" -czf "web-$(GAME).tar.gz" "web-$(GAME)"
	@echo "wrote $(CURDIR)/web-$(GAME).tar.gz"
