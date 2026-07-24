---
"demake": minor
---

Game Gear fully end to end — the fourth console to complete the pixel-perfect
loop, sharing the SMS codegen family and the genesis-plus-gx core.

- **Viewport-aware ROM building**: the GG LCD shows only the central 160×144
  crop of the shared 256×192 VDP frame, so the `sms`-family ROM builder now
  offsets the image into the name table by the crop margin ((VDP−display)/2, in
  tiles → 6×3 for the GG). The image lands at the visible window's top-left, so a
  `.gg` boots displaying the art exactly where `renderCompliant` expects it. The
  SMS is full-frame (zero margin), so its output is unchanged.
- **Sprite-list termination in the SMS/GG harness**: fresh VRAM leaves all 64
  sprites at Y=0/X=0 pointing at the sprite pattern base ($2000 = tile 256),
  which drew garbage over the top-left once an image exceeded 256 tiles. The
  harness now writes the Y=$D0 list terminator to the sprite attribute table.
- **Shared extensive emulator battery**: the deliberately-extreme case set the
  GB family established (flat, full-screen gradient + noise, mirror symmetry,
  per-cell palettes, the 8×8 minimum) is now a shared helper, and NES, SMS, and
  GG all march through the identical battery scaled to their full screen.
- **CLI `--format rom` E2E coverage** for the `nes`, `sms`, and `gg` families
  alongside the existing GB coverage.
