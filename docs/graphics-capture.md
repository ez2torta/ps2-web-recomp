# Local GS texture diagnostics

For a native software-rendered diagnostic run, `PS2_CAPTURE` selects frames to record. `PS2_CAPTURE_TEXTURES=1` adds decoded PPM texture images; `PS2_CAPTURE_RAW=1` additionally writes index bytes and the 512-entry active CLUT for indexed textures. The CLUT is written as little-endian 32-bit entries, and the indices are one byte per texel in row-major order at the dimensions shown in the PPM header. These extra files are only written for the software rasterizer. They describe the texture and active CLUT at the start of each captured draw batch, not necessarily the original uploaded resource.

For a register-write trace, set `PS2_TRACE_GSSEQ=1`. The trace prints the packed GS register number and its 64-bit value. For packed `A+D` writes (`reg=0E`), it also prints `ad=NN`, the GS register address stored in the low byte of the second qword. The trace is limited to 100,000 writes and is diagnostic only; it does not validate the register values or explain their effect.

```sh
mkdir -p /tmp/ps2-capture
PS2_GS=software PS2_ONE_THREAD=1 \
  PS2_CAPTURE='1234,/tmp/ps2-capture,1' PS2_CAPTURE_TEXTURES=1 PS2_CAPTURE_RAW=1 \
  build/native-mygame/ps2run games/mygame/disc/SLUS_123.45 \
  --disc games/mygame/disc.iso --frames 1236
```

Use a frame and paths appropriate to the game. Captures may contain game data: keep them local. `PS2_CAPTURE_RAW` has no effect without texture capture and does not enable it by itself. Comparing captures from different frames can reveal differences, but does not establish which one is incorrect.

With `PS2_CAPTURE_TRANSFERS=1`, the software renderer also records the incoming bytes of each host-to-local transfer started during the selected capture. `draws.tsv` associates each `.gs-transfer` file with its preceding transfer registers. These are the input chunks received by the transfer path, including any packet padding, and can be incomplete when a transfer crosses the capture boundary. They do not identify the source in EE memory. The output can be large and contains game data; use only for local diagnostics.

Each draw row in `draws.tsv` includes the raw `XYOFFSET` and `SCISSOR` register values and the min/max raw 16-bit `XYZ` XY fields as `raw_xy`. A batch is split when either register changes, so its bounds and raster state refer to the same GS setup. The existing `box` column remains the vertex bounds after subtracting `XYOFFSET`, in pixels; these bounds are not clipped to `SCISSOR`, so an extreme box alone does not imply out-of-bounds writes. `texels` gives the texture-coordinate bounds.

The added columns and batch-key split were applied after the Concert/Esaka investigation found identical XY offset and scissor state but very different incoming vertex ranges. This is opt-in diagnostic metadata only; it does not change rasterization.

Set `PS2_CAPTURE_VERTICES=1` to write `vertices.tsv` for primitives with at least one XY vertex farther than 512 pixels outside the active scissor rectangle. The file contains all vertices of each selected primitive, both raw GS values and projected pixel coordinates, plus UV/STQ and draw-batch identity. Set `PS2_CAPTURE_VERTEX_MARGIN=N` to change that pixel margin. This can create large logs for scenes with lots of off-screen geometry, so keep it enabled only for short captures.

In the KOF XI Concert/Esaka samples, this filter captured 118 Concert and 206 Esaka primitives (35 KB and 59 KB respectively). Esaka included many `(x,y,z)=(0,0,0)` vertices; 77/206 selected triangles had exactly zero projected area and are discarded by the current software rasterizer. Eighteen selected Esaka triangles had bounding boxes intersecting the 640×448 scissor, including several non-degenerate triangles anchored at that origin. Bounding-box overlap does not prove they shade pixels, nor that the origin is invalid; it identifies a focused set for comparison against an independent GS implementation.
