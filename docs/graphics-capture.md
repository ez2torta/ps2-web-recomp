# Local GS texture diagnostics

For a native software-rendered diagnostic run, `PS2_CAPTURE` selects frames to record. `PS2_CAPTURE_TEXTURES=1` adds decoded PPM texture images; `PS2_CAPTURE_RAW=1` additionally writes index bytes and the 512-entry active CLUT for indexed textures. The CLUT is written as little-endian 32-bit entries, and the indices are one byte per texel in row-major order at the dimensions shown in the PPM header. These extra files are only written for the software rasterizer. They describe the texture and active CLUT at the start of each captured draw batch, not necessarily the original uploaded resource.

```sh
mkdir -p /tmp/ps2-capture
PS2_GS=software PS2_ONE_THREAD=1 \
  PS2_CAPTURE='1234,/tmp/ps2-capture,1' PS2_CAPTURE_TEXTURES=1 PS2_CAPTURE_RAW=1 \
  build/native-mygame/ps2run games/mygame/disc/SLUS_123.45 \
  --disc games/mygame/disc.iso --frames 1236
```

Use a frame and paths appropriate to the game. Captures may contain game data: keep them local. `PS2_CAPTURE_RAW` has no effect without texture capture and does not enable it by itself. Comparing captures from different frames can reveal differences, but does not establish which one is incorrect.

With `PS2_CAPTURE_TRANSFERS=1`, the software renderer also records the incoming bytes of each host-to-local transfer started during the selected capture. `draws.tsv` associates each `.gs-transfer` file with its preceding transfer registers. These are the input chunks received by the transfer path, including any packet padding, and can be incomplete when a transfer crosses the capture boundary. They do not identify the source in EE memory. The output can be large and contains game data; use only for local diagnostics.
