---
"@demake/demotic": minor
"@demake/core": minor
"demake": minor
---

Compile Demotic games to Game Boy machine code, with their art demade.

`demake build game.dmt -o game.gb` writes a real 32 KiB cartridge, and the web
app builds and plays the identical one in the page.

**The backend is a compiler, not a fixed engine.** This reverses doc 14 §2's
"compile to data, not to assembly", which is rewritten with the reasoning and
the measurement. A game becomes SM83 written for it: entities at constant
addresses, rule loops unrolled over the objects that can match, comparisons
lowered to branches, constants folded. Helpers are pulled rather than pushed, so
a game that never divides ships no divider and one that never calls `random`
ships no generator; work RAM is allocated per object rather than per worst case.
Game Boy frames per game tick went from 3–11 to 1.00–1.01 across the example
library, so a game now keeps up with the hardware.

The assembler is ours (`codegen/asm.ts`, TypeScript, no dependencies), so builds
still need no toolchain and the browser still produces byte-identical ROMs — the
doc-07 parity contract is kept by compiling in both places rather than by
patching a checked-in blob.

**Levels, tile collision, the camera and scrolling compile**, so every game in
the example library builds and matches the reference interpreter tick for tick,
`caves` and `runner` included.

**Art goes through the image pipeline.** `@demake/core` gains its own
deterministic SVG rasteriser — `decodeImage` now accepts SVG — because a host
rasteriser antialiases how it likes and would make the browser and the CLI
disagree about a cartridge's bytes. It also gains `buildSpriteBank`, the sprite
path from doc 15 §The conversion path: index 0 is transparency, objects take the
shades their backdrop is not drawn in, art is auto-contrasted across them over
every asset at once, and tiles deduplicate across the whole build. `buildGbRom`
takes the asset bytes and converts them itself, so both edges get the same
cartridge from the same sources.

New `@demake/demotic` surface: `buildGbRom`, `unsupportedFeatures`, `artRequests`,
`bindArt`, `analyze`, `planLayout`, `Asm`, and the `rom*` trace readers.
`@demake/dmg` is a dependency-free Game Boy core that runs the conformance suite
headlessly and plays the cartridge in the web app, where doc 07 forbids a CDN
core.

`demake build --format tables` becomes `--format sym`, which emits the symbol map
of the code generated for this game — what a cycle profile needs now that the
code is game-specific.

Fixes: `PushSprite` clobbered the tile number with the OAM shadow's address, so
every object drew whatever tile lived at `$C0`.

No image output bytes change; game ROM bytes do.
