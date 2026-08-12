# 06 — Code Generation (`gen`)

`gen` turns a `CompliantImage` into artifacts a retro developer (or our own test
harness) can use directly. It generalizes `gen-portraits.py`, which emitted RGBDS
assembly containing 3 BGR555 palettes + a 49-byte tile→palette map + 784 bytes of
2bpp tile data, with an exact path for compliant inputs and a lossy fallback.

## Input paths

1. **Compliant image (exact path)** — detector verifies the pixels satisfy the
   console spec (≤K colors per cell, cells groupable into ≤P palettes, budgets met);
   conversion is then lossless. A manifest sidecar, if present and hash-matching,
   short-circuits detection and pins palette order.
2. **Arbitrary image (implicit prep)** — runs the full doc-04 pipeline first, then
   the exact path. `--strict` disables this.

## Output formats (`--format`)

### `bin` — raw data blobs
Native-endian, hardware-layout binary per asset (tiles, map, palettes), suitable for
`incbin`. One file per asset or a single packed file with a JSON index. This is the
substrate the other formats wrap.

### `asm` — assembler source
Idiomatic source for the console's canonical assembler, with labels, size constants,
and a generated header comment (tool version, source hash, options — no timestamps,
determinism rule). Data encoded as `db`/`dw`/`dc.b` lines or backtick-graphics where
the assembler supports it (RGBDS gets backtick 2bpp rows like `gen-portraits.py`).

### `c` — C arrays + header
`const` arrays with correct types/attributes for the console's C toolchain (GBDK,
SGDK, libgba/libnds, cc65, devkitSMS…), plus a `.h` with extents and palette counts.
`--symbol` sets the identifier prefix.

### `rom` — complete bootable ROM
Data + a minimal display program, assembled/compiled *by us* (see §ROM building).
The ROM boots, initializes video, uploads palettes/tiles/map (or framebuffer),
and displays the image forever. This is both a user feature ("see it on real
hardware / any emulator now") and the foundation of the entire test strategy
(doc 10).

## Per-family backends

Backends live in `core/src/codegen/<family>.ts`; consoles map onto shared families
where the data formats genuinely coincide.

| Family | Consoles | Data emitted | Display code / toolchain for `rom` |
|---|---|---|---|
| `gb` | DMG, GBC (Mega Duck via variant) | 2bpp planar tiles, BG map, BGP shades / BGR555 pals + attr map (bank1) | RGBDS (`rgbasm/rgblink/rgbfix`) |
| `nes` | NES | 2bpp planar CHR, nametable, attribute table, 4×4 palette bytes | ca65/ld65 (NROM harness) |
| `snes` | SNES | 4bpp SNES tiles (plane pairs 0/1 then 2/3), tilemap words, CGRAM BGR555 | WLA-DX (`wla-65816` + `wlalink`), LoROM harness |
| `md` | Mega Drive | 4bpp packed tiles, plane map words (pal/prio bits), CRAM BGR333 | vasm m68k (tiny bare-metal harness) or SGDK for the `c` format |
| `sms` | SMS, GG, SG-1000 mode targets | 4bpp planar tiles, name table, CRAM (RGB222/RGB444); TMS mode: pattern+color tables | WLA-DX or z88dk/devkitSMS |
| `tms` | SG-1000, ColecoVision | Graphics II pattern/color/name tables | z88dk harness per BIOS/boot quirks |
| `gba` | GBA | mode0 4bpp tiles (low-nibble-first) + screen entries + 16 BGR555 pals (mode3/4 bitmaps later) | GNU ARM binutils (`arm-none-eabi-as/ld/objcopy`); header in the harness |
| `nds` | NDS | engine-A text BG: the `gba` formats unchanged (ext. palettes / framebuffer later) | GNU ARM binutils; `.nds` cartridge packed by demake itself, no ndstool |
| `pce` | PC Engine | 4bpp word-planar characters (bitplanes 0/1 then 2/3), BAT entries, 9-bit VCE palettes | WLA-DX (`wla-huc6280` + `wlalink`), 64 KiB HuCard harness |
| `neogeo` | Neo Geo | 16×16 sprite tiles in the C-ROM pair (`.c1.bin`/`.c2.bin`), SCB1 word pairs, palette RAM words | GNU m68k binutils; `.neo` container packed by demake itself. The **tile is not the spec's tile**: a pixel costs what an 8×8 4bpp layout says and the hardware's unit is 16×16, so a 2×2 block of language cells is composed before anything is deduped |
| `a26` | Atari 2600 | kernel-specific playfield/sprite tables **plus the kernel itself** (the display code *is* the format) | dasm |
| `a78` | Atari 7800 | display lists + graphics data + palette regs | dasm/cc7800 harness |
| `a8` | Atari 5200/8-bit | ANTIC display list + screen data + GTIA regs | MADS/cc65 |
| `lynx` | Lynx | 4bpp framebuffer + palette (+ optional per-line reload table) | cc65 lynx target |
| `wsc` | WonderSwan Color | 4bpp packed tiles (left pixel high nibble), screen-map words (tile/palette/bank/flip), 16 RGB444 palettes | NASM (16-bit x86 for the V30MZ); 4 Mbit cartridge packed by demake itself |
| `ws` | WonderSwan (mono) | planar 2bpp tiles, the Color's screen-map word, the shade pool (`.pool.bin`) and 4-entry palettes (`.pal.bin`) as the two register runs they are | NASM (16-bit x86 for the V30MZ); 4 Mbit cartridge packed by demake itself. The pool is *derived* from the picture, because a compliant image stores the level an entry shows and not the slot it came from |
| `ngpc` | NGP/NGPC | 2bpp characters (a row is a little-endian halfword, leftmost pixel highest), scroll-map words, **BGR**444 palettes | none — no distribution ships a TLCS-900/H assembler, so the display program is emitted with `@demake/core`'s own `Asm900` and the cartridge header packed by demake itself |
| `intv` | Intellivision | GRAM cards + BACKTAB words | jzIntv as1600 |
| `mono-misc` | Virtual Boy, Pokémon Mini, Supervision, Game.com | per-platform tile/fb formats | per-platform assemblers, validated in Tier 3 rollout |

Backend contract (uniform, tested):

```ts
interface CodegenBackend {
  family: string;
  emitBin(img: CompliantImage): NamedBlob[];
  emitAsm(img: CompliantImage, opts): string;
  emitC(img: CompliantImage, opts): { c: string; h: string };
  romHarness: {                      // doc 10 uses this
    templateDir: string;             // rom-harness/<family>/
    toolchainImage: string;          // ghcr.io/<owner>/demake-tc-<family>:<tag>
    build(blobs: NamedBlob[]): RomBuildPlan;   // file placements + build cmd
  };
}
```

## ROM building — who runs the toolchain?

The CLI itself does **not** bundle assemblers. `--format rom` works in two ways:

1. **Local toolchain**: if the family's assembler is on `PATH` (detected, versions
   allow-listed), `gen` writes the harness project to a temp dir, builds, and emits
   the ROM. Errors clearly name the missing tool + install hint (`E_TOOLCHAIN_MISSING`).
2. **Docker fallback** (`--rom-builder docker`): uses our published
   `demake-tc-<family>` images — the exact ones CI uses — for a zero-setup,
   reproducible build. Recommended path; documented as the default suggestion.

The **web app** cannot run toolchains: it offers `bin`/`asm`/`c` downloads for all
consoles, plus true in-browser `rom` for families where assembly is simple enough to
implement in TS (GB family and NES NROM first — both are straightforward fixed-layout
links; stretch goal per family thereafter, tracked in the roadmap).

## The Demotic backend (doc 14)

A Demotic game build does not emit data for a fixed engine to interpret. It
**compiles the game to machine code**: a backend takes the front end's `Program`
and generates code written for that game — entities at constant addresses, rule
loops unrolled over the objects that can match, comparisons lowered to branches
— with only the helper routines something in it actually reached.

That reverses an earlier decision recorded here, and doc 14 §2 has the reasoning
and the measurement. The short version: the fixed engine could not fit a game
tick inside a Game Boy frame, and could not leave out the features a game did
not use. Both are structural, and both cost more than the N + M saving was
worth.

| Family | CPU | State |
|---|---|---|
| `gb` | SM83 | **written** (`packages/demotic/src/codegen/`) |
| `nes` | 6502 | planned |
| `sms` | Z80 (SMS + GG) | planned |
| `md` | 68000 | planned |
| `snes` | 65816 | planned |

A backend brings its own instruction encoder rather than borrowing the image
path's toolchain, which is the N × M cost doc 14 §2 accepts deliberately. It is
also what makes the next line true.

**In-browser ROM assembly needs no assembler installed, because ours is
TypeScript.** `packages/demotic/src/codegen/asm.ts` encodes SM83 with labels and
forward-reference fixups, so the page compiles the same cartridge the CLI does
and the two are byte-identical (doc 07 §parity). There is no blob to check in,
no staleness test, and no format contract restated in an assembly file — the
three pieces of machinery the patching approach needed, all gone with it.

Art goes through the image pipeline on the way. `buildGbRom` takes the asset
bytes the game names and converts them itself (doc 15 §The conversion path), so
the browser and the CLI cannot diverge on a tile: both hand over the same source
and every decision from rasterising to dedup happens in one place.

`gen` emits *image* artifacts from images and is unchanged by any of this.

## The audio backends (doc 16)

`gen` on an audio artifact emits the same four formats, plus the one thing images
never need: **the player code**. `bin` is the packed music or effect data,
`asm`/`c` add the driver source, and `rom` is a bootable cartridge that plays the
track — the counterpart of the display harness, and the foundation of the audio
proof loop (doc 10).

The driver is *generated for this track*, on exactly the reasoning doc 14 §2
records for games: a fixed player ships every feature because it cannot know
which ones this song uses, and on a cartridge that is the budget rather than an
abstraction cost. A track with no vibrato ships no vibrato code. The same
pull-based `ctx.need(name, body)` discipline applies — helpers are pulled, never
pushed, never pruned afterwards.

What the driver must guarantee is narrow, exact and testable: **on tick N it
performs exactly the writes the `ChipScript` lists for tick N, in order, within
the cycle budget.** How the data is compressed, whether patterns are shared, how
the order list is walked — none of it is observable in the register stream, so
none of it is part of the contract. Doc 16 §The driver contract has the detail;
doc 16 §The proof has the oracle that checks it.

The Nintendo boot logo stays zero, on the same principle as the NDS builder: we
ship no copyrighted data. A built ROM therefore direct-boots in emulators and
does not boot on original hardware; `demake build --boot-logo` asks `rgbfix` to
stamp it, which is the one optional step that wants a toolchain.

## Tile handling

- Deduplication (with H/V flip where hardware maps support it) is performed by
  `prep`'s budget stage; `gen` emits the deduped tileset + map faithfully.
  `gen-portraits.py` skipped dedup (49 unique tiles); we don't.
- Map origin/layout options per family: `--map-base`, `--tile-base`, padding to
  power-of-two rows, and SGDK/GBDK-compatible layouts so output drops into existing
  projects without munging.

## Output hygiene

- All generated source carries: tool name+version, source file hash, full option
  string, and a "regenerate with:" command line — and **no timestamps** (byte-
  determinism). Headers use each language family's comment syntax.
- `--json` mode reports every artifact written with byte sizes and hashes.
