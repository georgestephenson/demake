---
"@demake/core": minor
"@demake/demotic": minor
"@demake/dmg": minor
---

The Game Boy is green, and Demotic games build for the Game Boy Color.

**The green LCD.** `@demake/dmg`'s four DMG shades were grey; they are now the
ramp the `dmg` console spec has always carried as its `mono-ramp` DAC model —
`(155, 188, 15)` through `(15, 56, 15)` — which is the same one the SameBoy
capturer already compared against. A DAC model is a tested artifact here rather
than decoration, so `packages/dmg/test/ppu.test.ts` pins the two together and
the page, the CLI's PNG and the pixel-perfect E2E now show one colour. Anything
that measured "brightness" on that framebuffer had to be re-read against it: the
web E2E's `romPainted` counts pixels that differ from the modal colour, because
a red-channel threshold called a whole green screen dark.

**`demake build -c gbc` is a real Game Boy Color cartridge.** It is the _same
machine code_ as the monochrome build with a second half bolted to the renderer:
an attribute byte per background cell in VRAM bank 1, eight background and eight
object palettes of RGB555, an OAM attribute carrying each object's palette and
tile bank, and a tile bank that may spill past 256 into the second bank. Every
rule, collision and tick compiles identically, so a game plays the same on both
consoles — `packages/demotic/test/rom.test.ts` now runs the whole example
library on `gb` _and_ `gbc` and asserts the traces match the reference
interpreter tick for tick, and that the two consoles' traces match each other.

The art is demade by the image engine, as ever, but through its RGB-lattice path
instead of its mono one. `packages/core/src/pipeline/sprite.ts` gained a colour
fit, and the interesting decision there is not which colours but **which assets
share a sub-palette** — the constrained assignment the tiled fitter already
solves for an image's attribute cells, with an asset in place of a cell, because
the hardware names one palette per object. Backdrops come through `prep` with
their attributes and palettes, which the `gb` image backend already emitted for
the `gbc` spec.

One background palette and one object palette are reserved for the font, so a
score stays legible over a title screen whose palettes were chosen for the title
screen. `PrepOptions.maxSubPalettes` and `SpriteOptions.maxPalettes` are how that
reservation reaches the engine, and both are new public options.

**Colour costs cartridge, the way audio does** — an attribute byte per backdrop
cell, the palettes each scene uploads, and the extra tiles colour art costs,
coming to about a kilobyte for a game with two demade backdrops. The build
reports what is left; a game that no longer fits is an error naming the number.

`@demake/dmg` is both machines now, and which one is the _cartridge's_ decision:
two VRAM banks, palette RAM behind `BCPS`/`BCPD` and `OCPS`/`OCPD`, banked work
RAM, CGB object priority and the `$11` boot register, all gated on the header
flag. There is no switch, because a machine you can set independently of the
cartridge is a machine that can be set wrong. `stampGbHeader` takes a `cgb`
option and stamps `$C0` — CGB-_only_, since the runtime programs palette RAM
from its first instruction.

In the web app the console selector now changes the cartridge rather than only
the preview: picking Game Boy Color builds a `.gbc` and the same core plays it in
colour. Demaking a picture in colour is the whole `prep` tournament — seconds,
where the mono path is a fraction of one — so `bindArt` memoises the conversion
by content hash and the ROM pane defers its build by a frame and says
"demaking…" rather than freezing the tab.

**Output bytes change** for `gbc` builds, which previously produced a
DMG-compatible cartridge, and for anything reading `@demake/dmg`'s framebuffer.
A `gb` build's bytes are unchanged.
