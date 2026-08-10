---
"@demake/core": minor
"@demake/neogeo": minor
"demake": minor
---

Close the four remaining display-ROM gaps: `demake gen --format rom` now builds a
bootable cartridge for the **Mega Duck**, the **mono WonderSwan**, the **Neo Geo
Pocket Color** and the **Neo Geo**, and each is proven pixel-perfect in a
third-party emulator against the DAC reference.

Two of the four cost a description rather than a harness. The Mega Duck rides the
`gb` family's own display program with a generated machine include built from
`asm/megaduck.ts` — the LCD registers it moved, `LCDC`'s shuffled bits, and the
fact that it has no cartridge header and therefore no `rgbfix` step — and its
emulator is **SameDuck**, SameBoy's own fork, which `emu-harness/gb/capture.c` is
now compiled against as well as SameBoy. The mono WonderSwan is the Color
builder around a harness that writes its palette to _ports_ rather than to RAM.
The Neo Geo Pocket Color is the second family with no third-party assembler
behind it, emitting its display program with `Asm900` exactly as the Virtual Boy
does with `Asm810`. The Neo Geo gains a `neogeo` codegen family — the one family
whose tile is not the console spec's tile, since a picture is composed into
16×16 hardware tiles before anything is deduped — and a `.neo` display cartridge
whose picture is twenty sticky-chained sprite strips.

**Output bytes change for the Neo Geo**, because booting a demade cartridge in
somebody else's emulator found three things no test of ours could:

- **The `.neo` container stores its P ROM byte-swapped**, as a MAME set does.
  `packNeoRom` now applies that and `loadNeo` undoes it, so nothing above the
  container changes — but until now a demade Neo Geo cartridge would not have run
  on real hardware or in any other emulator.
- **A sprite tile's leftmost pixel is the least significant bit**, not the most.
  `packNeoCharacters` and `unpackNeoCharacters` agreed with each other and with
  nothing else, which drew every tile mirrored.
- **The palette bank's last entry is the backdrop**, so the console spec declares
  255 sub-palettes rather than 256: a fit given all of them puts a colour where
  the backdrop goes and has it replaced.

Also: `extractTiles` takes an optional tile size (the Neo Geo's 16×16) and rounds
the tile count up rather than down, so a picture that is a whole number of 8×8
cells but half of a hardware tile keeps its last row and column. The LSPC's VRAM
addresses and SCB word encoders move from `@demake/neogeo` into
`core/src/asm/neo-lspc.ts`, which the emulator re-exports — three things need
them now, and a hardware fact implemented three times is one that disagrees in
one entry in one of them.
