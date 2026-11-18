#!/usr/bin/env bash
# Optional, explicit concurrency bound for the engine's Ninja invocations.
ps2_ninja() {
  if [ -n "${PS2_BUILD_JOBS:-}" ]; then
    if [[ ! "$PS2_BUILD_JOBS" =~ ^[1-9][0-9]*$ ]]; then
      echo 'PS2_BUILD_JOBS must be a positive integer' >&2
      return 2
    fi
    ninja -j "$PS2_BUILD_JOBS" "$@"
  else
    ninja "$@"
  fi
}
