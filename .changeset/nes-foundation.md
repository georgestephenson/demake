---
"@demake/core": minor
"demake": minor
---

Add the NES to `prep`/`inspect`/`consoles` — the first Tier-1 breadth console,
and the first to exercise three schema features the Game Boy did not:

- **Fixed-master color.** A new `fixed-master` hardware color space snaps working
  colors to the NES's built-in 64-entry master palette (nearest in Oklab); the
  fitter and k-means already consumed the color space abstractly, so they gained
  it for free. `inspect` learns the master palette as the valid color set.
- **16×16 attribute cells.** Geometry now snaps output dimensions to the
  *attribute-cell* size rather than the tile size (they coincide on the GB), so
  every pixel belongs to a fully-covered palette cell — the NES chooses one
  sub-palette per 16×16 cell over 8×8 tiles.
- **Shared backdrop.** The fitter accepts a reserved color forced into index 0 of
  every sub-palette, so all four NES background palettes share the universal
  backdrop ($3F00) and a value-0 pixel renders uniformly (≤ 13 colors on screen).
  `inspect`'s structural oracle verifies the sharing.

`prep -c nes` produces compliant, deterministic images that `inspect -c nes`
certifies. The `nes` codegen backend (CHR/nametable/attribute/palette), an NROM
ROM harness, the cc65 toolchain, and the headless-emulator E2E are the next
steps — this lands the doc-02 "step 1" (a console works for prep/inspect from its
spec alone).
